import 'dotenv/config';
import express from 'express';
import { GoogleGenAI } from '@google/genai';
import multer from 'multer';
import XLSX from 'xlsx';
import archiver from 'archiver';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const upload = multer({ storage: multer.memoryStorage() });

app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Base paths ----------
// In production (Railway), use bundled data/ folder inside app directory
// In local dev, use the BSC workspace root for full access to all files
const LOCAL_BSC_ROOT = path.resolve(__dirname, '..', '..');
const USE_BUNDLED = process.env.USE_BUNDLED === 'true' || !existsSync(path.join(LOCAL_BSC_ROOT, 'product_images'));
const BSC_ROOT = USE_BUNDLED ? __dirname : (process.env.BSC_ROOT || LOCAL_BSC_ROOT);
const DATA_DIR = path.join(__dirname, 'data');

// ---------- Load campaigns config ----------
function loadCampaigns() {
  const configPath = path.join(__dirname, 'campaigns.json');
  if (!existsSync(configPath)) return {};
  return JSON.parse(readFileSync(configPath, 'utf-8'));
}

// ---------- API key middleware ----------
function getClient(req) {
  const key = req.headers['x-api-key'] || process.env.GEMINI_API_KEY;
  if (!key) throw new Error('No API key provided');
  return new GoogleGenAI({ apiKey: key });
}

// ---------- Image helpers ----------
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);

function getMimeType(ext) {
  const map = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp' };
  return map[ext] || 'image/jpeg';
}

function loadImagesFromFolder(folder) {
  if (!existsSync(folder)) return [];
  const files = readdirSync(folder).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith('desktop'));
  return files.map(file => {
    const filePath = path.join(folder, file);
    const ext = path.extname(file).toLowerCase();
    const data = readFileSync(filePath).toString('base64');
    return { name: file, mimeType: getMimeType(ext), data };
  });
}

function loadProductImages(productsDir, productNames) {
  const images = [];
  for (const name of productNames) {
    const folder = path.join(productsDir, name.trim());
    const loaded = loadImagesFromFolder(folder);
    images.push(...loaded);
  }
  return images;
}

// ---------- Auto-save generated images locally ----------
const OUTPUT_DIR = USE_BUNDLED
  ? path.join(__dirname, 'output')
  : path.join(BSC_ROOT, 'ads', 'generated_images', 'app');

function saveImageLocally(imageData, mimeType, campaignId) {
  try {
    if (!existsSync(OUTPUT_DIR)) mkdirSync(OUTPUT_DIR, { recursive: true });
    const ext = mimeType?.includes('png') ? 'png' : 'jpg';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
    const prefix = campaignId || 'gen';
    const filename = `${prefix}_${timestamp}_${Math.random().toString(36).slice(2, 6)}.${ext}`;
    const filePath = path.join(OUTPUT_DIR, filename);
    writeFileSync(filePath, Buffer.from(imageData, 'base64'));
    console.log(`Saved: ${filePath}`);
    return filename;
  } catch (err) {
    console.error('Auto-save error:', err.message);
    return null;
  }
}

// ==========================================================
// CAMPAIGN API ENDPOINTS
// ==========================================================

// List all campaigns
app.get('/api/campaigns', (req, res) => {
  const campaigns = loadCampaigns();
  const list = Object.entries(campaigns).map(([id, c]) => ({
    id,
    name: c.name,
    hasProducts: !!c.productSlug,
    defaultAspectRatio: c.defaultAspectRatio,
    defaultResolution: c.defaultResolution,
  }));
  res.json({ campaigns: list });
});

// ---------- Resolve campaign paths (bundled or local) ----------
function resolveProductFolder(campaign) {
  if (!campaign.productSlug) return null;
  // Try local BSC workspace first
  const localPath = path.join(BSC_ROOT, 'product_images', campaign.productSlug);
  if (existsSync(localPath)) return localPath;
  // Fall back to bundled data/
  const bundledPath = path.join(DATA_DIR, 'product_images', campaign.productSlug);
  if (existsSync(bundledPath)) return bundledPath;
  return null;
}

function resolveInspirationFolder(campaignId, campaign) {
  if (!campaign.inspirationFolder && !campaignId) return null;
  // Try local BSC workspace first
  if (campaign.inspirationFolder) {
    const localPath = path.join(BSC_ROOT, campaign.inspirationFolder);
    if (existsSync(localPath)) return localPath;
  }
  // Fall back to bundled data/ using campaign ID
  const bundledPath = path.join(DATA_DIR, 'inspirations', campaignId);
  if (existsSync(bundledPath)) return bundledPath;
  return null;
}

// Get campaign details + product image thumbnails
app.get('/api/campaigns/:id/products', (req, res) => {
  const campaigns = loadCampaigns();
  const campaign = campaigns[req.params.id];
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!campaign.productSlug) return res.json({ images: [], message: 'No product folder configured for this campaign' });

  const folder = resolveProductFolder(campaign);
  if (!folder) return res.json({ images: [], message: 'Product folder not found' });

  // Load specified product images (or all if none specified)
  const specifiedImages = campaign.productImages || {};
  const imageNames = Object.values(specifiedImages).filter(Boolean);

  let images = [];
  if (imageNames.length) {
    for (const fileName of imageNames) {
      const filePath = path.join(folder, fileName);
      if (!existsSync(filePath)) continue;
      const ext = path.extname(fileName).toLowerCase();
      const data = readFileSync(filePath).toString('base64');
      const role = Object.entries(specifiedImages).find(([, v]) => v === fileName)?.[0] || 'other';
      images.push({ name: fileName, role, mimeType: getMimeType(ext), data });
    }
  } else {
    images = loadImagesFromFolder(folder);
  }

  res.json({ images, folder });
});

// Get campaign inspiration thumbnails (lightweight — names + small previews)
app.get('/api/campaigns/:id/inspirations', (req, res) => {
  const campaigns = loadCampaigns();
  const campaign = campaigns[req.params.id];
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });

  const folder = resolveInspirationFolder(req.params.id, campaign);
  if (!folder) return res.json({ images: [] });

  const files = readdirSync(folder).filter(f => IMAGE_EXTS.has(path.extname(f).toLowerCase()) && !f.startsWith('desktop'));
  // Return file names and paths — frontend will lazy-load thumbnails
  const images = files.map(f => ({ name: f, path: path.join(folder, f) }));
  res.json({ images });
});

// Serve an inspiration image by campaign + filename
app.get('/api/campaigns/:id/inspiration-image/:filename', (req, res) => {
  const campaigns = loadCampaigns();
  const campaign = campaigns[req.params.id];
  if (!campaign) return res.status(404).send('Not found');

  const folder = resolveInspirationFolder(req.params.id, campaign);
  if (!folder) return res.status(404).send('Not found');

  const filePath = path.join(folder, req.params.filename);
  if (!existsSync(filePath)) return res.status(404).send('Not found');

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', getMimeType(ext));
  res.send(readFileSync(filePath));
});

// Get campaign design style (markdown)
app.get('/api/campaigns/:id/design-style', (req, res) => {
  const campaigns = loadCampaigns();
  const campaign = campaigns[req.params.id];
  if (!campaign || !campaign.designStylePath) return res.json({ content: '' });

  // Try local first, then bundled
  let filePath = path.join(BSC_ROOT, campaign.designStylePath);
  if (!existsSync(filePath)) {
    filePath = path.join(DATA_DIR, 'design_styles', `${req.params.id}.md`);
  }
  if (!existsSync(filePath)) return res.json({ content: '' });

  res.json({ content: readFileSync(filePath, 'utf-8') });
});

// ==========================================================
// AUTO-GENERATE PROMPT FROM REFERENCE IMAGE
// ==========================================================
app.post('/api/generate-from-reference', async (req, res) => {
  try {
    const { campaignId, referenceImages, model, aspectRatio, imageSize } = req.body;
    if (!referenceImages?.length) return res.status(400).json({ error: 'At least one reference image is required' });

    const ai = getClient(req);
    const campaigns = loadCampaigns();
    const campaign = campaignId ? campaigns[campaignId] : null;
    const modelId = model || 'gemini-3-pro-image-preview';

    // Build content parts: product images first, then reference images, then instruction
    const contentParts = [];
    let hasProductImages = false;

    // 1. Load campaign product images (resolves bundled or local)
    if (campaign && campaign.productSlug) {
      const folder = resolveProductFolder(campaign);
      const specifiedImages = campaign.productImages || {};
      const imageNames = Object.values(specifiedImages).filter(Boolean);

      if (imageNames.length && folder) {
        for (const fileName of imageNames) {
          const filePath = path.join(folder, fileName);
          if (!existsSync(filePath)) continue;
          const ext = path.extname(fileName).toLowerCase();
          const data = readFileSync(filePath).toString('base64');
          contentParts.push({ inlineData: { mimeType: getMimeType(ext), data } });
        }
        hasProductImages = contentParts.length > 0;
      }
    }

    // 2. Add reference/inspiration images
    for (const img of referenceImages) {
      contentParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
    }

    // 3. Build the auto-prompt instruction
    let instruction = '';

    if (hasProductImages) {
      instruction += 'ABSOLUTE #1 PRIORITY — PRODUCT PRESERVATION:\n' +
        'The FIRST attached image(s) are the REAL product photos. You MUST copy this product PIXEL FOR PIXEL.\n' +
        '- Copy the EXACT product shape, logo text "BOMBAY SHAVING COMPANY" in exact same stacked font and position\n' +
        '- Copy the EXACT chrome-to-matte-black transition, orange accent ring, circular power button, oval LED display, T-blade head\n' +
        '- If a travel case is in the product photos, copy it EXACTLY — black hard case with "BOMBAY SHAVING COMPANY" in white stacked text\n' +
        '- DO NOT approximate. DO NOT redesign. COPY the product exactly.\n' +
        '- Product accuracy is MORE important than the scene. Never compromise on the product.\n\n';
    }

    instruction += 'TASK: The LAST attached image(s) are REFERENCE/INSPIRATION images showing a layout, composition, and visual style.\n' +
      'Create a NEW product advertisement that:\n' +
      '1. Uses the EXACT same layout, composition, spacing, and visual style from the reference/inspiration image\n' +
      '2. Replaces the product in the reference with the REAL product from the product photos (first images) — copied PIXEL FOR PIXEL\n' +
      '3. Adapts colors, lighting, and mood to match the campaign aesthetic\n' +
      '4. Do NOT copy any text, headlines, brand names, or copy from the reference images — write fresh text appropriate for this BSC campaign\n' +
      '5. The reference shows HOW the creative should look (layout, style), not WHAT it should say (text, copy)\n\n';

    if (campaign?.systemPromptExtra) {
      instruction += `CAMPAIGN RULES: ${campaign.systemPromptExtra}\n\n`;
    }

    instruction += 'BRAND STYLE: Bombay Shaving Company — premium, bold, angular. ' +
      'Crisp lighting, sharp shadows.\n\n' +
      'LOGO RULE — NON-NEGOTIABLE: Do NOT add "BOMBAY SHAVING COMPANY" or any BSC logo as a standalone text element, ' +
      'header, footer, watermark, or design element in the creative layout. The logo should ONLY appear where it ' +
      'physically exists on the real product body and travel case. No floating logo. No header logo. No corner logo. ' +
      'No text overlay of the brand name.\n\n';

    instruction += 'Generate exactly ONE image. The product must be the EXACT product from the product reference photos. ' +
      'The layout and style must match the inspiration reference. 2K resolution.';

    contentParts.push({ text: instruction });

    const finalAspectRatio = aspectRatio || campaign?.defaultAspectRatio || '9:16';
    const finalImageSize = imageSize || campaign?.defaultResolution || '2K';

    const response = await ai.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts: contentParts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: finalAspectRatio,
          imageSize: finalImageSize,
        },
      },
    });

    const parts = response.candidates?.[0]?.content?.parts || [];
    let imageData = null;
    let textData = '';

    for (const part of parts) {
      if (part.inlineData && !imageData) {
        imageData = { mimeType: part.inlineData.mimeType, data: part.inlineData.data };
      }
      if (part.text) textData += part.text;
    }

    if (!imageData) {
      return res.status(422).json({ error: 'No image generated. The model may have refused this prompt.', text: textData });
    }

    const savedFile = saveImageLocally(imageData.data, imageData.mimeType, campaignId);
    res.json({ image: imageData, text: textData, savedFile });
  } catch (err) {
    console.error('Generate-from-reference error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// PARSE STRUCTURED MARKDOWN PROMPT FILES
// ==========================================================
function parseStructuredMarkdown(text) {
  const items = [];
  const blocks = text.split(/={3,}/);

  for (const block of blocks) {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!lines.length) continue;

    const headerIdx = lines.findIndex(l => /^PROMPT\s+\d+/i.test(l));
    if (headerIdx === -1) continue;

    const titleMatch = lines[headerIdx].match(/—\s*(.+)$/);
    const title = titleMatch ? titleMatch[1].trim() : '';

    let aspectRatio = '1:1';
    const ratioLine = lines.find(l => /^Ratio:\s*/i.test(l));
    if (ratioLine) {
      const ratioMatch = ratioLine.match(/Ratio:\s*(\d+:\d+)/i);
      if (ratioMatch) aspectRatio = ratioMatch[1];
    }

    let imageSize = '2K';
    const ratioIdx = lines.findIndex(l => /^Ratio:\s*/i.test(l));
    const promptStartIdx = (ratioIdx !== -1 ? ratioIdx : headerIdx) + 1;
    const promptLines = lines.slice(promptStartIdx);
    const promptText = promptLines.join(' ').trim();

    if (!promptText) continue;

    const resMatch = promptText.match(/\b(512|1K|2K|4K)\s*resolution\b/i);
    if (resMatch) imageSize = resMatch[1];

    let products = '';
    const productLine = lines.find(l => /^Products?:\s*/i.test(l));
    if (productLine) {
      products = productLine.replace(/^Products?:\s*/i, '').trim();
    }

    items.push({ prompt: promptText, aspectRatio, imageSize, products, title });
  }

  return items;
}

// ==========================================================
// PARSE UPLOADED FILE TO PROMPT LIST
// ==========================================================
app.post('/api/parse-file', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(file.originalname).toLowerCase();
    let items = [];

    if (ext === '.csv' || ext === '.xlsx' || ext === '.xls') {
      const workbook = XLSX.read(file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
      items = rows
        .filter(r => String(r[0] || '').trim())
        .map(r => ({
          prompt: String(r[0] || '').trim(),
          aspectRatio: String(r[1] || '1:1').trim(),
          imageSize: String(r[2] || '2K').trim(),
          products: String(r[3] || '').trim(),
        }));
    } else if (ext === '.txt' || ext === '.md') {
      const text = file.buffer.toString('utf-8');
      if (text.includes('====')) {
        items = parseStructuredMarkdown(text);
      } else {
        const rows = text.split('\n').map(l => l.split('|').map(c => c.trim()));
        items = rows
          .filter(r => String(r[0] || '').trim())
          .map(r => ({
            prompt: String(r[0] || '').trim(),
            aspectRatio: String(r[1] || '1:1').trim(),
            imageSize: String(r[2] || '2K').trim(),
            products: String(r[3] || '').trim(),
          }));
      }
    } else {
      return res.status(400).json({ error: 'Unsupported file type. Use .csv, .xlsx, .xls, .txt, or .md' });
    }

    res.json({ items });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// LIST PRODUCT FOLDERS (legacy — kept for backward compat)
// ==========================================================
app.get('/api/products', (req, res) => {
  const productsDir = req.headers['x-products-path'] || process.env.PRODUCTS_PATH || '';
  if (!productsDir || !existsSync(productsDir)) {
    return res.json({ folders: [], error: productsDir ? 'Folder not found' : null });
  }
  try {
    const entries = readdirSync(productsDir, { withFileTypes: true });
    const folders = entries.filter(e => e.isDirectory()).map(e => e.name);
    res.json({ folders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// GENERATE A SINGLE IMAGE (campaign-aware)
// ==========================================================
app.post('/api/generate', async (req, res) => {
  try {
    const { prompt, model, aspectRatio, imageSize, products, uploadedImages, campaignId, referenceImages } = req.body;
    const productsDir = req.headers['x-products-path'] || process.env.PRODUCTS_PATH || '';
    if (!prompt) return res.status(400).json({ error: 'Prompt is required' });

    const ai = getClient(req);
    const modelId = model || 'gemini-3-pro-image-preview';

    // Load campaign config if provided
    const campaigns = loadCampaigns();
    const campaign = campaignId ? campaigns[campaignId] : null;

    // Build content parts: product images first, then reference images, then text prompt
    const contentParts = [];
    let hasProductImages = false;

    // 1. Campaign product images (auto-loaded — resolves bundled or local)
    if (campaign && campaign.productSlug) {
      const folder = resolveProductFolder(campaign);
      const specifiedImages = campaign.productImages || {};
      const imageNames = Object.values(specifiedImages).filter(Boolean);

      if (imageNames.length && folder) {
        for (const fileName of imageNames) {
          const filePath = path.join(folder, fileName);
          if (!existsSync(filePath)) continue;
          const ext = path.extname(fileName).toLowerCase();
          const data = readFileSync(filePath).toString('base64');
          contentParts.push({ inlineData: { mimeType: getMimeType(ext), data } });
        }
        hasProductImages = contentParts.length > 0;
      }
    }

    // 2. Uploaded product images (override campaign images if provided)
    if (uploadedImages?.length) {
      if (!hasProductImages) {
        for (const img of uploadedImages) {
          contentParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
        }
        hasProductImages = true;
      }
    } else if (!hasProductImages && products && productsDir) {
      // 3. Legacy: folder-based product images
      const productNames = products.split(',').map(p => p.trim()).filter(Boolean);
      const productImages = loadProductImages(productsDir, productNames);
      for (const img of productImages) {
        contentParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
      hasProductImages = productImages.length > 0;
    }

    // 4. Reference/inspiration images
    if (referenceImages?.length) {
      for (const img of referenceImages) {
        contentParts.push({ inlineData: { mimeType: img.mimeType, data: img.data } });
      }
      systemPrefix += 'REFERENCE IMAGES: The reference/inspiration images are for DESIGN ONLY. ' +
        'Use them ONLY for layout, composition, spacing, lighting, and visual style. ' +
        'Do NOT copy any text, headlines, brand names, or copy from the reference images. ' +
        'Write fresh text appropriate for this BSC campaign. The references show HOW the creative should look, not WHAT it should say.\n\n';
    }

    // Build system instruction
    let systemPrefix = '';

    if (hasProductImages) {
      systemPrefix += 'ABSOLUTE #1 PRIORITY — PRODUCT PRESERVATION:\n' +
        'The first attached image(s) show the EXACT real product. You MUST copy this product PIXEL FOR PIXEL.\n' +
        '- Copy the EXACT product shape — do not redesign, reimagine, simplify, or create a "similar" product\n' +
        '- Copy the EXACT logo text "BOMBAY SHAVING COMPANY" in the exact same stacked font, exact same position on the body\n' +
        '- Copy the EXACT chrome-to-matte-black transition on the body\n' +
        '- Copy the EXACT orange accent ring at the trimmer head base\n' +
        '- Copy the EXACT circular power button with metallic finish\n' +
        '- Copy the EXACT oval LED display area showing "99"\n' +
        '- Copy the EXACT T-blade head shape at the top\n' +
        '- If a travel case is shown in the reference, copy it EXACTLY — black hard case with "BOMBAY SHAVING COMPANY" logo in white stacked text\n' +
        '- If attachment heads are shown, copy their EXACT shapes — do not invent new shapes\n' +
        'DO NOT approximate. DO NOT create a "similar looking" product. COPY the reference product exactly.\n' +
        'The product accuracy is MORE important than the scene, background, or text. If you must compromise, compromise on the scene — NEVER on the product.\n\n';
    }

    systemPrefix += 'CRITICAL — TEXT RENDERING: When the prompt specifies text to appear in the image, ' +
      'you MUST render that text EXACTLY as written — correct spelling, exact wording. ' +
      'Use bold condensed uppercase sans-serif font (like Elza Condensed Black or Impact). ' +
      'Text color, position, and size as specified in the prompt. ' +
      'Text in the image is mandatory, not optional. ' +
      'Generate exactly ONE image, not multiple.\n\n';

    systemPrefix += 'BRAND STYLE: Bombay Shaving Company aesthetic — bold, angular. ' +
      'Crisp lighting with distinct angles and sharp shadows. ' +
      'Clean, uncluttered composition. Maximum visual impact.\n\n' +
      'CRITICAL — PRODUCT ACCURACY: The product(s) in the reference images are REAL product photos. ' +
      'Your output MUST contain these exact products — not redesigned versions, not approximations. ' +
      'Copy EVERY detail: shape, material (plastic vs metal), color, texture, labels, logos on packaging. ' +
      'If a product is matte black plastic — render it as matte black plastic, NOT as chrome or metallic. ' +
      'If a product is chrome metal — render it as chrome metal. Match the reference EXACTLY. ' +
      'Wrong product appearance = useless output. Accuracy over creativity.\n\n' +
      'LOGO RULE — NON-NEGOTIABLE: Do NOT add "BOMBAY SHAVING COMPANY" or any BSC logo as a standalone text element, ' +
      'header, footer, watermark, or design element in the creative layout. The logo should ONLY appear where it ' +
      'physically exists on the real product packaging. No floating logo. No header logo. No corner logo. ' +
      'No text overlay of the brand name.\n\n';

    // Campaign-specific system prompt
    if (campaign?.systemPromptExtra) {
      systemPrefix += `CAMPAIGN RULES: ${campaign.systemPromptExtra}\n\n`;
    }

    contentParts.push({ text: systemPrefix + prompt });

    // Use campaign defaults if not overridden
    const finalAspectRatio = aspectRatio || campaign?.defaultAspectRatio || '1:1';
    const finalImageSize = imageSize || campaign?.defaultResolution || '2K';

    const response = await ai.models.generateContent({
      model: modelId,
      contents: [{ role: 'user', parts: contentParts }],
      config: {
        responseModalities: ['TEXT', 'IMAGE'],
        imageConfig: {
          aspectRatio: finalAspectRatio,
          imageSize: finalImageSize,
        },
      },
    });

    // Extract FIRST image only from response
    const parts = response.candidates?.[0]?.content?.parts || [];
    let imageData = null;
    let textData = '';

    for (const part of parts) {
      if (part.inlineData && !imageData) {
        imageData = {
          mimeType: part.inlineData.mimeType,
          data: part.inlineData.data,
        };
      }
      if (part.text) {
        textData += part.text;
      }
    }

    if (!imageData) {
      return res.status(422).json({ error: 'No image generated. The model may have refused this prompt.', text: textData });
    }

    const savedFile = saveImageLocally(imageData.data, imageData.mimeType, campaignId);
    res.json({ image: imageData, text: textData, savedFile });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// PARSE BRIEF FILE (xlsx/csv)
// ==========================================================
app.post('/api/parse-brief', upload.single('file'), (req, res) => {
  try {
    const file = req.file;
    if (!file) return res.status(400).json({ error: 'No file uploaded' });

    const ext = path.extname(file.originalname).toLowerCase();
    if (!['.csv', '.xlsx', '.xls'].includes(ext)) {
      return res.status(400).json({ error: 'Upload .csv, .xlsx, or .xls brief file' });
    }

    const workbook = XLSX.read(file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

    const headerIdx = rows.findIndex(r => {
      if (!r || r.length < 3) return false;
      const stringCells = r.filter(cell => typeof cell === 'string' && cell.trim().length > 1);
      return stringCells.length >= 3 && r.some(cell =>
        typeof cell === 'string' && /concept|brief|headline|visual|hook|prompt|title|funnel|persona|direction/i.test(cell)
      );
    });
    if (headerIdx === -1) return res.status(400).json({ error: 'Could not find header row. Ensure your file has column headers like Headline, Visual Direction, Brief Title, etc.' });

    const headers = rows[headerIdx].map(h => String(h || '').trim());
    const briefs = [];

    const promptCol = headers.find(h => /nano\s*banana\s*prompt|prompt|gemini\s*prompt/i.test(h));

    for (let i = headerIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row || row.every(cell => cell == null || String(cell).trim() === '')) continue;
      if (row[0] != null && typeof row[0] !== 'number' && String(row[0]).trim() === '') continue;

      const brief = {};
      headers.forEach((h, idx) => {
        if (h && row[idx] != null) brief[h] = String(row[idx]).trim();
      });
      const filledCols = Object.values(brief).filter(v => v && v.length > 1).length;
      if (filledCols >= 2) {
        briefs.push(brief);
      }
    }

    res.json({ briefs, headers: headers.filter(Boolean), promptCol: promptCol || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// EXPAND BRIEFS INTO OPTIMIZED PROMPTS
// ==========================================================
app.post('/api/expand-briefs', async (req, res) => {
  try {
    const { briefs, productDescription, campaignId } = req.body;
    if (!briefs?.length) return res.status(400).json({ error: 'No briefs provided' });

    const ai = getClient(req);
    const campaigns = loadCampaigns();
    const campaign = campaignId ? campaigns[campaignId] : null;

    const campaignContext = campaign?.systemPromptExtra ? `\nCAMPAIGN-SPECIFIC RULES: ${campaign.systemPromptExtra}\n` : '';

    const systemPrompt = `You are an expert ad creative prompt engineer for AI image generation (Google Gemini Nano Banana), specializing in Bombay Shaving Company (BSC) brand creatives.

Your job: convert structured ad creative briefs into detailed, optimized image generation prompts that follow BSC's brand guidelines and proven ad performance patterns.

Actual product photos will be attached when generating — so NEVER describe the product's physical appearance in detail. Refer to it as "the product from the reference image" or "THIS exact product". CRITICAL: Every prompt MUST include the instruction "Copy the product from the reference image EXACTLY — same shape, same logo, same proportions. Do not redesign or approximate."

${productDescription ? `PRODUCT CONTEXT: ${productDescription}\n` : ''}${campaignContext}
BSC BRAND GUIDELINES:
- Brand personality: "The Outlaw" — bold, disruptive, confident, real
- Typography: Headlines in bold condensed uppercase sans-serif (like Elza Condensed Black). Subheads in clean sans-serif (like Aktiv Grotesk). NEVER use thin, elegant, or serif fonts.
- Colors: Primary black (#000000) and white (#ffffff). Secondary accents: orange-red (#ea5839), red (#e21c24), teal (#62c0c3), yellow (#fdc818), blue (#3180c2), pink (#f093bd)
- Photography style: Crisp lighting with distinct angles and sharp shadows. Products placed at angles (never straight upright). Multi-tiered platforms/podiums. Angular compositions reflecting logo's 5-degree cut.
- FBT proven winners: Dark/black backgrounds (8 of 11 top performers). Product as hero — no models. Travel case visible. Attachments spread in frame. Light bursts/glows behind product silhouette. Feature callouts as floating chip/badge-style labels (scannable, not readable). Social proof as notification-style UI.
- Performance ads: Logo minimal or absent. Max 2-3 text elements per image (headline + subline + CTA). Bold condensed uppercase white or neon text.

RULES:
1. Each brief has columns like: Concept Name, Headline, Subline, Visual Direction, Background, Product Display, Ratio, Notes
2. Use ALL the brief details — especially Visual Direction, Background, Product Display, Headline text, and Subline text
3. Keep each prompt under 150 words — scene, composition, lighting, mood, camera angle
4. HEADLINE and SUBLINE text MUST appear in the image exactly as written — specify: bold condensed uppercase sans-serif font, color (white/neon on dark bg, or as brief specifies), position (top/center/bottom), and size (large/small)
5. Default to dark/black backgrounds unless the brief explicitly specifies otherwise
6. Always include angular lighting, sharp shadows, and product glow/backlight effects
7. Feature callouts should be styled as floating chip/badge labels with semi-transparent backgrounds
8. End every prompt with "2K resolution"
9. Respect the Ratio column from the brief
10. Output ONLY in this exact parseable format:

PROMPT [N] — [CONCEPT NAME]
Ratio: [from brief]

[detailed prompt text]

====

No other text, explanations, or commentary. Just the prompts.`;

    const briefList = briefs.map((b, i) => {
      const fields = Object.entries(b)
        .filter(([k, v]) => v && k !== '#')
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n');
      return `--- Brief ${i + 1} ---\n${fields}`;
    }).join('\n\n');

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: `${systemPrompt}\n\nHere are ${briefs.length} briefs to expand:\n\n${briefList}`,
      config: { responseModalities: ['TEXT'] },
    });

    const text = response.candidates?.[0]?.content?.parts?.[0]?.text || '';
    res.json({ expandedText: text });
  } catch (err) {
    console.error('Expand error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// DOWNLOAD ALL IMAGES AS ZIP
// ==========================================================
app.post('/api/download-zip', express.json({ limit: '200mb' }), (req, res) => {
  try {
    const { images } = req.body;
    if (!images?.length) return res.status(400).json({ error: 'No images to download' });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="generated-images.zip"');

    const archive = archiver('zip', { zlib: { level: 5 } });
    archive.pipe(res);

    for (const img of images) {
      const buffer = Buffer.from(img.data, 'base64');
      const ext = img.mimeType?.includes('png') ? 'png' : 'jpg';
      archive.append(buffer, { name: `${img.filename}.${ext}` });
    }

    archive.finalize();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==========================================================
// START
// ==========================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`BSC Creative Generator running at http://localhost:${PORT}`);
  console.log(`Mode: ${USE_BUNDLED ? 'BUNDLED (production)' : 'LOCAL (dev)'}`);
  console.log(`Data: ${USE_BUNDLED ? DATA_DIR : BSC_ROOT}`);
});
