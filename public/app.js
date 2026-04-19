// ============================================================
// State
// ============================================================
const state = {
  results: [],
  selected: new Set(),
  generating: false,
  aborted: false,
  campaignId: '',
  campaignProducts: [],    // auto-loaded from campaign
  referenceImages: [],      // user-uploaded or picked from inspirations
  uploadedImages: [],       // legacy — kept for backward compat
  briefs: [],
  titles: [],
};

// ============================================================
// DOM refs
// ============================================================
const $ = (s) => document.querySelector(s);
const $$ = (s) => document.querySelectorAll(s);

const els = {
  campaignSelect: $('#campaignSelect'),
  apiKey:       $('#apiKey'),
  model:        $('#model'),
  aspectRatio:  $('#aspectRatio'),
  concurrency:  $('#concurrency'),
  productSection: $('#productSection'),
  productImagePreview: $('#productImagePreview'),
  referenceSection: $('#referenceSection'),
  referenceUploadArea: $('#referenceUploadArea'),
  referenceInput: $('#referenceInput'),
  referencePreview: $('#referencePreview'),
  inspirationBrowser: $('#inspirationBrowser'),
  inspirationGrid: $('#inspirationGrid'),
  inspirationCount: $('#inspirationCount'),
  productDesc:  $('#productDesc'),
  briefDrop:    $('#briefDrop'),
  briefFileInput: $('#briefFileInput'),
  briefStatus:  $('#briefStatus'),
  briefTable:   $('#briefTable'),
  briefActions: $('#briefActions'),
  btnExpandBrief: $('#btnExpandBrief'),
  expandStatus: $('#expandStatus'),
  promptText:   $('#promptText'),
  promptCount:  $('#promptCount'),
  promptPreview: $('#promptPreview'),
  promptText2:  $('#promptText2'),
  promptPreviewCount: $('#promptPreviewCount'),
  fileInput:    $('#fileInput'),
  fileDrop:     $('#fileDrop'),
  fileStatus:   $('#fileStatus'),
  btnGenerate:  $('#btnGenerate'),
  btnStop:      $('#btnStop'),
  btnClear:     $('#btnClear'),
  progressSection: $('#progressSection'),
  progressText: $('#progressText'),
  progressNumbers: $('#progressNumbers'),
  progressFill: $('#progressFill'),
  statSuccess:  $('#statSuccess'),
  statFailed:   $('#statFailed'),
  statTime:     $('#statTime'),
  gallerySection: $('#gallerySection'),
  galleryGrid:  $('#galleryGrid'),
  btnSelectAll: $('#btnSelectAll'),
  btnDeselectAll: $('#btnDeselectAll'),
  btnDownloadSelected: $('#btnDownloadSelected'),
  btnDownloadAll: $('#btnDownloadAll'),
  imageModal:   $('#imageModal'),
  modalImage:   $('#modalImage'),
  modalPrompt:  $('#modalPrompt'),
  modalDownload: $('#modalDownload'),
};

// ============================================================
// Tabs
// ============================================================
$$('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    $$('.tab').forEach(t => t.classList.remove('active'));
    $$('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    $(`#tab-${tab.dataset.tab}`).classList.add('active');
  });
});

// ============================================================
// Campaign Selection
// ============================================================
async function loadCampaigns() {
  try {
    const res = await fetch('/api/campaigns');
    const data = await res.json();
    els.campaignSelect.innerHTML = '<option value="">— Select Campaign —</option>';
    for (const c of data.campaigns) {
      const opt = document.createElement('option');
      opt.value = c.id;
      opt.textContent = c.name;
      els.campaignSelect.appendChild(opt);
    }
  } catch (err) {
    console.error('Failed to load campaigns:', err);
  }
}

els.campaignSelect.addEventListener('change', async () => {
  state.campaignId = els.campaignSelect.value;
  if (!state.campaignId) {
    els.productSection.classList.add('hidden');
    els.referenceSection.classList.add('hidden');
    state.campaignProducts = [];
    state.referenceImages = [];
    return;
  }

  // Load campaign products
  await loadCampaignProducts(state.campaignId);

  // Load campaign inspirations
  await loadCampaignInspirations(state.campaignId);

  // Set default aspect ratio
  const opt = els.campaignSelect.selectedOptions[0];
  // Fetch campaign details to get defaults
  try {
    const res = await fetch(`/api/campaigns/${state.campaignId}/products`);
    const data = await res.json();
    // Also find defaults from campaign list
    const listRes = await fetch('/api/campaigns');
    const listData = await listRes.json();
    const campaign = listData.campaigns.find(c => c.id === state.campaignId);
    if (campaign?.defaultAspectRatio) {
      els.aspectRatio.value = campaign.defaultAspectRatio;
    }
  } catch {}

  // Show reference section
  els.referenceSection.classList.remove('hidden');
});

async function loadCampaignProducts(campaignId) {
  try {
    const res = await fetch(`/api/campaigns/${campaignId}/products`);
    const data = await res.json();
    state.campaignProducts = data.images || [];

    if (state.campaignProducts.length) {
      els.productSection.classList.remove('hidden');
      els.productImagePreview.innerHTML = state.campaignProducts.map(img => `
        <div class="product-thumb">
          <img src="data:${img.mimeType};base64,${img.data}" alt="${img.name}" />
          <div class="product-thumb-name">${img.role || img.name}</div>
        </div>
      `).join('');
    } else {
      els.productSection.classList.add('hidden');
    }
  } catch (err) {
    console.error('Failed to load products:', err);
    els.productSection.classList.add('hidden');
  }
}

async function loadCampaignInspirations(campaignId) {
  try {
    const res = await fetch(`/api/campaigns/${campaignId}/inspirations`);
    const data = await res.json();

    if (data.images?.length) {
      els.inspirationBrowser.classList.remove('hidden');
      els.inspirationCount.textContent = `${data.images.length} inspirations`;
      els.inspirationGrid.innerHTML = data.images.map(img => `
        <div class="inspiration-thumb" data-name="${escapeHtml(img.name)}" data-campaign="${campaignId}">
          <img src="/api/campaigns/${campaignId}/inspiration-image/${encodeURIComponent(img.name)}" alt="${escapeHtml(img.name)}" loading="lazy" />
          <div class="inspiration-check hidden">✓</div>
        </div>
      `).join('');

      // Click to select/deselect inspiration
      els.inspirationGrid.querySelectorAll('.inspiration-thumb').forEach(thumb => {
        thumb.addEventListener('click', () => toggleInspiration(thumb));
      });
    } else {
      els.inspirationBrowser.classList.add('hidden');
    }
  } catch (err) {
    console.error('Failed to load inspirations:', err);
    els.inspirationBrowser.classList.add('hidden');
  }
}

async function toggleInspiration(thumb) {
  const name = thumb.dataset.name;
  const campaignId = thumb.dataset.campaign;
  const check = thumb.querySelector('.inspiration-check');
  const isSelected = !check.classList.contains('hidden');

  if (isSelected) {
    // Deselect
    check.classList.add('hidden');
    thumb.classList.remove('selected');
    state.referenceImages = state.referenceImages.filter(r => r.name !== name);
  } else {
    // Select — fetch full image
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/inspiration-image/${encodeURIComponent(name)}`);
      const blob = await res.blob();
      const data = await blobToBase64(blob);
      state.referenceImages.push({ name, mimeType: blob.type, data });
      check.classList.remove('hidden');
      thumb.classList.add('selected');
    } catch (err) {
      console.error('Failed to load inspiration:', err);
    }
  }
  renderReferencePreview();
}

// ============================================================
// Reference Image Upload
// ============================================================
els.referenceUploadArea.addEventListener('click', () => els.referenceInput.click());
els.referenceUploadArea.addEventListener('dragover', e => { e.preventDefault(); els.referenceUploadArea.classList.add('drag-over'); });
els.referenceUploadArea.addEventListener('dragleave', () => els.referenceUploadArea.classList.remove('drag-over'));
els.referenceUploadArea.addEventListener('drop', e => {
  e.preventDefault();
  els.referenceUploadArea.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleReferenceFiles(e.dataTransfer.files);
});
els.referenceInput.addEventListener('change', () => {
  if (els.referenceInput.files.length) handleReferenceFiles(els.referenceInput.files);
});

async function handleReferenceFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const data = await fileToBase64(file);
    state.referenceImages.push({ name: file.name, mimeType: file.type, data });
  }
  renderReferencePreview();
}

function renderReferencePreview() {
  updateRefGenerateBar();
  if (!state.referenceImages.length) {
    els.referencePreview.classList.add('hidden');
    return;
  }
  els.referencePreview.classList.remove('hidden');
  els.referencePreview.innerHTML = state.referenceImages.map((img, i) => `
    <div class="product-thumb">
      <img src="data:${img.mimeType};base64,${img.data}" alt="${img.name}" />
      <button class="product-thumb-remove" data-idx="${i}">&times;</button>
      <div class="product-thumb-name">${img.name}</div>
    </div>
  `).join('');
  els.referencePreview.querySelectorAll('.product-thumb-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      const removed = state.referenceImages[idx];
      state.referenceImages.splice(idx, 1);
      // Deselect in inspiration grid if it was from there
      const thumb = els.inspirationGrid.querySelector(`[data-name="${CSS.escape(removed.name)}"]`);
      if (thumb) {
        thumb.classList.remove('selected');
        thumb.querySelector('.inspiration-check')?.classList.add('hidden');
      }
      renderReferencePreview();
    });
  });
}

// ============================================================
// Generate from Reference (no prompt needed)
// ============================================================
const refGenerateBar = $('#refGenerateBar');
const btnGenerateFromRef = $('#btnGenerateFromRef');
const refGenerateStatus = $('#refGenerateStatus');

function updateRefGenerateBar() {
  if (state.referenceImages.length > 0 && state.campaignId) {
    refGenerateBar.classList.remove('hidden');
    btnGenerateFromRef.textContent = state.referenceImages.length === 1
      ? 'Generate from Reference (1 image)'
      : `Generate from References (${state.referenceImages.length} images)`;
  } else {
    refGenerateBar.classList.add('hidden');
  }
}

// Generate one image per reference — 10 references = 10 images
btnGenerateFromRef.addEventListener('click', async () => {
  if (!state.referenceImages.length) return alert('Select at least one reference image.');
  if (!state.campaignId) return alert('Select a campaign first.');
  if (!els.apiKey.value.trim()) return alert('Enter your Gemini API key.');

  btnGenerateFromRef.disabled = true;
  state.aborted = false;

  // One result per reference image
  state.results = state.referenceImages.map(ref => ({
    prompt: `From reference: ${ref.name}`,
    aspectRatio: els.aspectRatio.value,
    imageSize: '2K',
    products: '',
    imageData: null, mimeType: null, status: 'pending', error: null,
    _ref: ref,
  }));
  state.selected.clear();
  state.generating = true;

  els.btnStop.classList.remove('hidden');
  els.gallerySection.classList.remove('hidden');
  els.progressSection.classList.remove('hidden');
  renderGallery();
  updateProgress();
  refGenerateStatus.textContent = `Generating ${state.referenceImages.length} images...`;

  const concurrency = parseInt(els.concurrency.value) || 2;
  const startTime = Date.now();
  let timerInterval = setInterval(() => {
    els.statTime.textContent = `⏱ ${Math.round((Date.now() - startTime) / 1000)}s`;
  }, 1000);

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < state.results.length && !state.aborted) {
      const i = nextIndex++;
      state.results[i].status = 'generating';
      renderCard(i);
      updateProgress();

      try {
        const res = await fetch('/api/generate-from-reference', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': els.apiKey.value.trim(),
          },
          body: JSON.stringify({
            campaignId: state.campaignId,
            referenceImages: [state.results[i]._ref],
            model: els.model.value,
            aspectRatio: state.results[i].aspectRatio,
            imageSize: '2K',
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        state.results[i].imageData = data.image.data;
        state.results[i].mimeType = data.image.mimeType;
        state.results[i].status = 'done';
      } catch (err) {
        state.results[i].status = 'failed';
        state.results[i].error = err.message;
      }
      renderCard(i);
      updateProgress();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  clearInterval(timerInterval);
  els.statTime.textContent = `⏱ ${Math.round((Date.now() - startTime) / 1000)}s`;
  state.generating = false;
  btnGenerateFromRef.disabled = false;
  els.btnStop.classList.add('hidden');
  const doneCount = state.results.filter(r => r.status === 'done').length;
  refGenerateStatus.textContent = state.aborted ? 'Stopped' : `Done! ${doneCount}/${state.results.length} images generated.`;
  els.progressText.textContent = state.aborted ? 'Stopped' : 'Complete!';
});

// ============================================================
// Helpers
// ============================================================
function fileToBase64(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(file);
  });
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result.split(',')[1]);
    reader.readAsDataURL(blob);
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function sanitizeFilename(str) {
  return str.substring(0, 80).replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '_') || 'image';
}

// ============================================================
// Brief Upload (Tab 1)
// ============================================================
els.briefDrop.addEventListener('click', () => els.briefFileInput.click());
els.briefDrop.addEventListener('dragover', e => { e.preventDefault(); els.briefDrop.classList.add('drag-over'); });
els.briefDrop.addEventListener('dragleave', () => els.briefDrop.classList.remove('drag-over'));
els.briefDrop.addEventListener('drop', e => {
  e.preventDefault();
  els.briefDrop.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleBriefFile(e.dataTransfer.files[0]);
});
els.briefFileInput.addEventListener('change', () => {
  if (els.briefFileInput.files.length) handleBriefFile(els.briefFileInput.files[0]);
});

async function handleBriefFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/parse-brief', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.briefs = data.briefs;
    state.promptCol = data.promptCol || null;
    els.briefStatus.textContent = `Loaded ${data.briefs.length} briefs from ${file.name}`;
    els.briefStatus.classList.remove('hidden');

    renderBriefTable(data.briefs, data.headers);
    els.briefActions.style.display = 'flex';

    if (state.promptCol && data.briefs.some(b => b[state.promptCol])) {
      const useExistingBtn = document.createElement('button');
      useExistingBtn.className = 'btn btn-secondary btn-use-existing';
      useExistingBtn.textContent = 'Use Pre-made Prompts';
      useExistingBtn.style.marginLeft = '8px';
      useExistingBtn.addEventListener('click', () => usePreMadePrompts());
      els.briefActions.querySelectorAll('.btn-use-existing').forEach(b => b.remove());
      els.briefActions.appendChild(useExistingBtn);
      els.expandStatus.textContent = `Found "${state.promptCol}" column — use pre-made prompts or generate new ones.`;
    }
  } catch (err) {
    alert('Brief parse error: ' + err.message);
  }
}

function usePreMadePrompts() {
  if (!state.briefs.length || !state.promptCol) return;
  const ratioKey = Object.keys(state.briefs[0]).find(k => /^ratio$/i.test(k.trim()));
  const lines = state.briefs
    .filter(b => b[state.promptCol])
    .map(b => {
      const prompt = b[state.promptCol];
      const ratio = (ratioKey && b[ratioKey]) || els.aspectRatio.value;
      const resMatch = prompt.match(/\b(512|1K|2K|4K)\s*resolution\b/i);
      const imageSize = resMatch ? resMatch[1] : '2K';
      return `${prompt} | ${ratio} | ${imageSize}`;
    });
  const text = lines.join('\n');
  els.promptText.value = text;
  els.promptText.dispatchEvent(new Event('input'));
  els.promptText2.value = text;
  els.promptPreviewCount.textContent = `${lines.length} prompts`;
  els.promptPreview.classList.remove('hidden');
  els.expandStatus.textContent = `Loaded ${lines.length} pre-made prompts. Click "Generate All Images" below.`;
}

function renderBriefTable(briefs, headers) {
  const preferredPatterns = [/^#$/, /brief.*title|concept/i, /headline/i, /subline|supporting/i, /visual.*direction/i, /ratio/i, /funnel/i];
  let cols = [];
  for (const pat of preferredPatterns) {
    const match = headers.find(h => pat.test(h));
    if (match) cols.push(match);
  }
  if (cols.length < 3) cols = headers.slice(0, 6);

  let html = '<table class="brief-table"><thead><tr>';
  cols.forEach(c => { html += `<th>${escapeHtml(c)}</th>`; });
  html += '</tr></thead><tbody>';
  briefs.forEach(b => {
    html += '<tr>';
    cols.forEach(c => { html += `<td title="${escapeHtml(b[c] || '')}">${escapeHtml(b[c] || '—')}</td>`; });
    html += '</tr>';
  });
  html += '</tbody></table>';
  els.briefTable.innerHTML = html;
  els.briefTable.classList.remove('hidden');
}

// Expand briefs into prompts
els.btnExpandBrief.addEventListener('click', async () => {
  if (!state.briefs.length) return alert('Upload a brief file first.');
  if (!els.apiKey.value.trim()) return alert('Enter your Gemini API key.');

  els.btnExpandBrief.disabled = true;
  els.expandStatus.textContent = `Expanding ${state.briefs.length} briefs into prompts...`;

  try {
    const res = await fetch('/api/expand-briefs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': els.apiKey.value.trim(),
      },
      body: JSON.stringify({
        briefs: state.briefs,
        productDescription: els.productDesc.value.trim(),
        campaignId: state.campaignId,
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    const expanded = parseExpandedPrompts(data.expandedText);
    els.promptText.value = expanded;
    els.promptText.dispatchEvent(new Event('input'));

    els.promptText2.value = expanded;
    const count = expanded.split('\n').filter(l => l.trim()).length;
    els.promptPreviewCount.textContent = `${count} prompts`;
    els.promptPreview.classList.remove('hidden');

    els.expandStatus.textContent = `Done! ${count} prompts generated. Click "Generate All Images" below.`;
    els.btnExpandBrief.textContent = 'Re-generate Prompts';
  } catch (err) {
    els.expandStatus.textContent = `Error: ${err.message}`;
  }
  els.btnExpandBrief.disabled = false;
});

function parseExpandedPrompts(text) {
  const blocks = text.split(/={3,}/);
  const lines = [];
  for (const block of blocks) {
    const blines = block.split('\n').map(l => l.trim()).filter(Boolean);
    if (!blines.length) continue;
    const headerIdx = blines.findIndex(l => /^PROMPT\s+\d+/i.test(l));
    if (headerIdx === -1) continue;
    let aspectRatio = els.aspectRatio.value;
    const ratioLine = blines.find(l => /^Ratio:\s*/i.test(l));
    if (ratioLine) {
      const m = ratioLine.match(/Ratio:\s*(\d+:\d+)/i);
      if (m) aspectRatio = m[1];
    }
    const ratioIdx = blines.findIndex(l => /^Ratio:\s*/i.test(l));
    const startIdx = (ratioIdx !== -1 ? ratioIdx : headerIdx) + 1;
    const promptText = blines.slice(startIdx).join(' ').trim();
    if (!promptText) continue;
    let imageSize = '2K';
    const resMatch = promptText.match(/\b(512|1K|2K|4K)\s*resolution\b/i);
    if (resMatch) imageSize = resMatch[1];
    lines.push(`${promptText} | ${aspectRatio} | ${imageSize}`);
  }
  return lines.join('\n');
}

// ============================================================
// Prompt counting (Tab 2)
// ============================================================
els.promptText.addEventListener('input', () => {
  const lines = els.promptText.value.split('\n').filter(l => l.trim());
  els.promptCount.textContent = lines.length;
});

// ============================================================
// Prompt File upload (Tab 3)
// ============================================================
els.fileDrop.addEventListener('click', () => els.fileInput.click());
els.fileDrop.addEventListener('dragover', e => { e.preventDefault(); els.fileDrop.classList.add('drag-over'); });
els.fileDrop.addEventListener('dragleave', () => els.fileDrop.classList.remove('drag-over'));
els.fileDrop.addEventListener('drop', e => {
  e.preventDefault();
  els.fileDrop.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handlePromptFile(e.dataTransfer.files[0]);
});
els.fileInput.addEventListener('change', () => {
  if (els.fileInput.files.length) handlePromptFile(els.fileInput.files[0]);
});

async function handlePromptFile(file) {
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/parse-file', { method: 'POST', body: formData });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    els.promptText.value = data.items.map(it => {
      let line = `${it.prompt} | ${it.aspectRatio} | ${it.imageSize}`;
      if (it.products) line += ` | ${it.products}`;
      return line;
    }).join('\n');
    els.promptText.dispatchEvent(new Event('input'));
    $$('.tab')[1].click();
    els.fileStatus.textContent = `Loaded ${data.items.length} prompts from ${file.name}`;
    els.fileStatus.classList.remove('hidden');
  } catch (err) {
    alert('File parse error: ' + err.message);
  }
}

// ============================================================
// Generate (campaign-aware)
// ============================================================
els.btnGenerate.addEventListener('click', startGeneration);
els.btnStop.addEventListener('click', () => { state.aborted = true; });

function parseLines(text) {
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const parts = line.split('|').map(p => p.trim());
    return {
      prompt: parts[0] || '',
      aspectRatio: parts[1] || els.aspectRatio.value,
      imageSize: parts[2] || '2K',
      products: parts[3] || '',
    };
  }).filter(item => item.prompt);
}

async function startGeneration() {
  const items = parseLines(els.promptText.value);
  if (!items.length) return alert('No prompts to generate.');
  if (!els.apiKey.value.trim()) return alert('Enter your Gemini API key.');

  state.results = items.map(item => ({
    prompt: item.prompt,
    aspectRatio: item.aspectRatio,
    imageSize: item.imageSize,
    products: item.products,
    imageData: null, mimeType: null, status: 'pending', error: null,
  }));
  state.selected.clear();
  state.generating = true;
  state.aborted = false;

  els.btnGenerate.disabled = true;
  els.btnStop.classList.remove('hidden');
  els.progressSection.classList.remove('hidden');
  els.gallerySection.classList.remove('hidden');
  renderGallery();
  updateProgress();

  const concurrency = parseInt(els.concurrency.value) || 2;
  const startTime = Date.now();
  let timerInterval = setInterval(() => {
    els.statTime.textContent = `⏱ ${Math.round((Date.now() - startTime) / 1000)}s`;
  }, 1000);

  let nextIndex = 0;

  async function worker() {
    while (nextIndex < state.results.length && !state.aborted) {
      const i = nextIndex++;
      state.results[i].status = 'generating';
      renderCard(i);
      updateProgress();

      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Api-Key': els.apiKey.value.trim(),
          },
          body: JSON.stringify({
            prompt: state.results[i].prompt,
            model: els.model.value,
            aspectRatio: state.results[i].aspectRatio,
            imageSize: state.results[i].imageSize,
            products: state.results[i].products,
            campaignId: state.campaignId || undefined,
            referenceImages: state.referenceImages.length ? state.referenceImages : undefined,
          }),
        });
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        state.results[i].imageData = data.image.data;
        state.results[i].mimeType = data.image.mimeType;
        state.results[i].status = 'done';
      } catch (err) {
        state.results[i].status = 'failed';
        state.results[i].error = err.message;
      }
      renderCard(i);
      updateProgress();
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  clearInterval(timerInterval);
  els.statTime.textContent = `⏱ ${Math.round((Date.now() - startTime) / 1000)}s`;
  state.generating = false;
  els.btnGenerate.disabled = false;
  els.btnStop.classList.add('hidden');
  els.progressText.textContent = state.aborted ? 'Stopped' : 'Complete!';
}

function updateProgress() {
  const total = state.results.length;
  const done = state.results.filter(r => r.status === 'done').length;
  const failed = state.results.filter(r => r.status === 'failed').length;
  const processed = done + failed;
  els.progressNumbers.textContent = `${processed} / ${total}`;
  els.progressFill.style.width = `${(processed / total) * 100}%`;
  els.statSuccess.textContent = `✓ ${done}`;
  els.statFailed.textContent = `✗ ${failed}`;
  els.progressText.textContent = processed < total ? 'Generating...' : 'Complete!';
}

// ============================================================
// Gallery
// ============================================================
function renderGallery() {
  els.galleryGrid.innerHTML = '';
  state.results.forEach((_, i) => els.galleryGrid.appendChild(createCardElement(i)));
}

function createCardElement(index) {
  const r = state.results[index];
  const card = document.createElement('div');
  card.className = `gallery-card${state.selected.has(index) ? ' selected' : ''}`;
  card.dataset.index = index;

  if (r.status === 'done' && r.imageData) {
    const src = `data:${r.mimeType};base64,${r.imageData}`;
    card.innerHTML = `
      <div class="card-checkbox" data-action="select">${state.selected.has(index) ? '✓' : ''}</div>
      <img class="card-image" src="${src}" alt="Generated" data-action="preview" loading="lazy" />
      <div class="card-footer">
        <span class="card-prompt" title="${escapeHtml(r.prompt)}">${escapeHtml(r.prompt)}</span>
        <button class="card-download" data-action="download" title="Download">⬇</button>
      </div>`;
  } else if (r.status === 'generating') {
    card.innerHTML = `
      <span class="card-status generating">Generating</span>
      <div class="card-placeholder"><div class="spinner"></div></div>
      <div class="card-footer"><span class="card-prompt">${escapeHtml(r.prompt)}</span></div>`;
  } else if (r.status === 'failed') {
    card.innerHTML = `
      <span class="card-status failed">Failed</span>
      <div class="card-placeholder" style="color:var(--danger);font-size:12px;padding:20px;text-align:center;">${escapeHtml(r.error || 'Generation failed')}</div>
      <div class="card-footer"><span class="card-prompt">${escapeHtml(r.prompt)}</span></div>`;
  } else {
    card.innerHTML = `
      <div class="card-placeholder" style="color:var(--text-dim);font-size:12px;">Queued</div>
      <div class="card-footer"><span class="card-prompt">${escapeHtml(r.prompt)}</span></div>`;
  }

  card.addEventListener('click', e => {
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'select') toggleSelect(index);
    else if (action === 'preview') openModal(index);
    else if (action === 'download') downloadSingle(index);
  });
  return card;
}

function renderCard(index) {
  const existing = els.galleryGrid.children[index];
  if (existing) existing.replaceWith(createCardElement(index));
}

function toggleSelect(index) {
  if (state.selected.has(index)) state.selected.delete(index);
  else state.selected.add(index);
  renderCard(index);
}

// ============================================================
// Select / Download
// ============================================================
els.btnSelectAll.addEventListener('click', () => {
  state.results.forEach((r, i) => { if (r.status === 'done') state.selected.add(i); });
  renderGallery();
});
els.btnDeselectAll.addEventListener('click', () => { state.selected.clear(); renderGallery(); });

function downloadSingle(index) {
  const r = state.results[index];
  if (!r.imageData) return;
  const ext = r.mimeType?.includes('png') ? 'png' : 'jpg';
  const byteString = atob(r.imageData);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  const blob = new Blob([ab], { type: r.mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeFilename(r.prompt) + '.' + ext;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

els.btnDownloadSelected.addEventListener('click', () => {
  const images = [];
  state.selected.forEach(i => {
    const r = state.results[i];
    if (r.imageData) images.push({ filename: sanitizeFilename(r.prompt), data: r.imageData, mimeType: r.mimeType });
  });
  if (!images.length) return alert('No images selected.');
  downloadZip(images);
});

els.btnDownloadAll.addEventListener('click', () => {
  const images = state.results.filter(r => r.status === 'done' && r.imageData)
    .map(r => ({ filename: sanitizeFilename(r.prompt), data: r.imageData, mimeType: r.mimeType }));
  if (!images.length) return alert('No images to download.');
  downloadZip(images);
});

async function downloadZip(images) {
  try {
    const res = await fetch('/api/download-zip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ images }),
    });
    if (!res.ok) throw new Error('ZIP download failed');
    const blob = await res.blob();
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'generated-images.zip';
    link.click();
    URL.revokeObjectURL(link.href);
  } catch (err) { alert('Download error: ' + err.message); }
}

// ============================================================
// Modal
// ============================================================
function openModal(index) {
  const r = state.results[index];
  if (!r.imageData) return;
  els.modalImage.src = `data:${r.mimeType};base64,${r.imageData}`;
  els.modalPrompt.textContent = r.prompt;
  els.modalDownload.onclick = () => downloadSingle(index);
  els.imageModal.classList.remove('hidden');
}
els.imageModal.querySelector('.modal-backdrop').addEventListener('click', closeModal);
els.imageModal.querySelector('.modal-close').addEventListener('click', closeModal);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeModal(); });
function closeModal() { els.imageModal.classList.add('hidden'); els.modalImage.src = ''; }

// ============================================================
// Clear
// ============================================================
els.btnClear.addEventListener('click', () => {
  state.results = [];
  state.selected.clear();
  els.galleryGrid.innerHTML = '';
  els.gallerySection.classList.add('hidden');
  els.progressSection.classList.add('hidden');
  els.progressFill.style.width = '0%';
});

// ============================================================
// Resize Workflow
// ============================================================
const resizeUploadArea = $('#resizeUploadArea');
const resizeInput = $('#resizeInput');
const resizePreview = $('#resizePreview');
const resizeTarget = $('#resizeTarget');
const btnResize = $('#btnResize');
const resizeResults = $('#resizeResults');
const resizeGrid = $('#resizeGrid');

const resizeState = { images: [], results: [] };
const btnDownloadAllResized = $('#btnDownloadAllResized');

resizeUploadArea.addEventListener('click', () => resizeInput.click());
resizeUploadArea.addEventListener('dragover', e => { e.preventDefault(); resizeUploadArea.classList.add('drag-over'); });
resizeUploadArea.addEventListener('dragleave', () => resizeUploadArea.classList.remove('drag-over'));
resizeUploadArea.addEventListener('drop', e => {
  e.preventDefault();
  resizeUploadArea.classList.remove('drag-over');
  if (e.dataTransfer.files.length) handleResizeFiles(e.dataTransfer.files);
});
resizeInput.addEventListener('change', () => {
  if (resizeInput.files.length) handleResizeFiles(resizeInput.files);
});

async function handleResizeFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const data = await fileToBase64(file);
    resizeState.images.push({ name: file.name, mimeType: file.type, data });
  }
  renderResizePreview();
}

function renderResizePreview() {
  btnResize.disabled = resizeState.images.length === 0;
  if (!resizeState.images.length) { resizePreview.classList.add('hidden'); return; }
  resizePreview.classList.remove('hidden');
  resizePreview.innerHTML = resizeState.images.map((img, i) => `
    <div class="product-thumb">
      <img src="data:${img.mimeType};base64,${img.data}" alt="${img.name}" />
      <button class="product-thumb-remove" data-ridx="${i}">&times;</button>
      <div class="product-thumb-name">${img.name}</div>
    </div>
  `).join('');
  resizePreview.querySelectorAll('.product-thumb-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      resizeState.images.splice(parseInt(btn.dataset.ridx), 1);
      renderResizePreview();
    });
  });
}

btnResize.addEventListener('click', async () => {
  if (!resizeState.images.length) return alert('Upload at least one image to resize.');
  if (!els.apiKey.value.trim()) return alert('Enter your Gemini API key.');

  btnResize.disabled = true;
  btnResize.textContent = 'Resizing...';
  resizeResults.classList.remove('hidden');
  resizeGrid.innerHTML = '';
  resizeState.results = [];

  const target = resizeTarget.value;

  for (let i = 0; i < resizeState.images.length; i++) {
    const img = resizeState.images[i];

    // Add placeholder
    const card = document.createElement('div');
    card.className = 'resize-card';
    card.innerHTML = `
      <div class="resize-pair">
        <div class="resize-original"><img src="data:${img.mimeType};base64,${img.data}" alt="Original" /><span>Original</span></div>
        <div class="resize-arrow">→</div>
        <div class="resize-output"><div class="card-placeholder"><div class="spinner"></div></div><span>Resizing to ${target}...</span></div>
      </div>`;
    resizeGrid.appendChild(card);

    try {
      const res = await fetch('/api/resize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Api-Key': els.apiKey.value.trim(),
        },
        body: JSON.stringify({
          image: { mimeType: img.mimeType, data: img.data },
          targetAspectRatio: target,
          imageSize: '2K',
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);

      resizeState.results.push({ name: img.name.replace(/\.[^.]+$/, '') + '_' + target.replace(':', 'x'), data: data.image.data, mimeType: data.image.mimeType });
      const outputDiv = card.querySelector('.resize-output');
      const rIdx = resizeState.results.length - 1;
      outputDiv.innerHTML = `
        <img src="data:${data.image.mimeType};base64,${data.image.data}" alt="Resized" />
        <span>${target}</span>
        <button class="btn btn-sm btn-primary resize-download" data-resize-idx="${rIdx}">Download</button>`;
      outputDiv.querySelector('.resize-download').addEventListener('click', () => {
        const r = resizeState.results[rIdx];
        downloadBase64(r.name, r.data, r.mimeType);
      });
    } catch (err) {
      const outputDiv = card.querySelector('.resize-output');
      outputDiv.innerHTML = `<div style="color:var(--danger);padding:20px;font-size:12px;">${escapeHtml(err.message)}</div><span>Failed</span>`;
    }
  }

  btnResize.disabled = false;
  btnResize.textContent = 'Resize All';
});

btnDownloadAllResized.addEventListener('click', async () => {
  if (!resizeState.results.length) return alert('No resized images to download.');
  const images = resizeState.results.map(r => ({ filename: r.name, data: r.data, mimeType: r.mimeType }));
  await downloadZip(images);
});

function downloadBase64(name, base64Data, mimeType) {
  const ext = mimeType?.includes('png') ? 'png' : 'jpg';
  const byteString = atob(base64Data);
  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) ia[i] = byteString.charCodeAt(i);
  const blob = new Blob([ab], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${name}.${ext}`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ============================================================
// Init
// ============================================================
const savedKey = sessionStorage.getItem('gemini_api_key');
if (savedKey) els.apiKey.value = savedKey;
els.apiKey.addEventListener('change', () => sessionStorage.setItem('gemini_api_key', els.apiKey.value));

// Load campaigns on start
loadCampaigns();
