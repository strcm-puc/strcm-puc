'use strict';

const https = require('https');
const { db, admin } = require('../firebase-config');
const { getCredential } = require('../vault-read');

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const CACHE_DOC    = 'whatsapp_templates';

// ── Meta Graph API helper ─────────────────────────────────────────────────────

function _graphGet(path, accessToken) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'graph.facebook.com',
      path,
      method:  'GET',
      headers: { Authorization: `Bearer ${accessToken}` },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end',  () => {
        try {
          const parsed = JSON.parse(raw);
          if (parsed.error) return reject(new Error(`Meta API: ${parsed.error.message}`));
          resolve(parsed);
        } catch (e) { reject(new Error(`Meta response parse failed: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Strip fields that Firestore can't store (e.g. example.body_text is array-of-arrays)
function _sanitize(t) {
  return {
    name:     t.name,
    status:   t.status,
    language: t.language ?? 'hi',
    components: (t.components ?? []).map(c => ({
      type:   c.type,
      format: c.format ?? null,
      text:   c.text   ?? null,
      // 'example' intentionally omitted — contains nested arrays unsupported by Firestore
    })),
  };
}

async function _fetchFromMeta(wabaId, accessToken) {
  const allTemplates = [];
  let path = `/v21.0/${wabaId}/message_templates?fields=name,status,language,components&limit=200`;

  while (path) {
    const data = await _graphGet(path, accessToken);
    if (Array.isArray(data.data)) allTemplates.push(...data.data);

    // Follow cursor pagination if more pages exist
    if (data.paging?.next) {
      const url  = new URL(data.paging.next);
      path = url.pathname + url.search;
    } else {
      path = null;
    }
  }

  const approved = allTemplates.filter(t => t.status === 'APPROVED').map(_sanitize);
  console.log(`[template-cache] Fetched ${allTemplates.length} templates, ${approved.length} approved`);
  return approved;
}

// ── Public API ────────────────────────────────────────────────────────────────

async function getApprovedTemplates() {
  // Check Firestore cache first
  const cacheSnap = await db.collection('system_cache').doc(CACHE_DOC).get();
  if (cacheSnap.exists) {
    const cached = cacheSnap.data();
    if (cached.expires_at && new Date(cached.expires_at) > new Date()) {
      console.log(`[template-cache] Using cached templates (${cached.count ?? '?'} approved, expires ${cached.expires_at})`);
      return cached.templates ?? [];
    }
  }

  // Cache miss or expired — fetch fresh
  const wa = await getCredential('whatsapp_api');
  const templates = await _fetchFromMeta(wa.waba_id_production, wa.access_token);

  const now = new Date();
  await db.collection('system_cache').doc(CACHE_DOC).set({
    templates,
    count:      templates.length,
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });

  return templates;
}

// Force-refresh the cache (call after template approval changes)
async function refreshTemplateCache() {
  const wa = await getCredential('whatsapp_api');
  const templates = await _fetchFromMeta(wa.waba_id_production, wa.access_token);
  const now = new Date();
  await db.collection('system_cache').doc(CACHE_DOC).set({
    templates,
    count:      templates.length,
    fetched_at: now.toISOString(),
    expires_at: new Date(now.getTime() + CACHE_TTL_MS).toISOString(),
    updated_at: admin.firestore.FieldValue.serverTimestamp(),
  });
  console.log(`[template-cache] Cache refreshed: ${templates.length} approved templates`);
  return templates;
}

module.exports = { getApprovedTemplates, refreshTemplateCache };
