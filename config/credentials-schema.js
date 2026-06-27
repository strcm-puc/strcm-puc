/**
 * Firestore collection: system_credentials
 * Document ID: {category} — one document per credential category.
 *
 * Defines field shapes only. No real secret values belong in this file.
 */

const COLLECTION = 'system_credentials';

const CREDENTIAL_SCHEMAS = {
  rcm_login: {
    description: 'RCM portal login credentials',
    fields: {
      username: { type: 'string', required: true },
      password: { type: 'string', required: true },
      store_code: { type: 'string', required: true, example: '116506' },
    },
  },
  whatsapp_api: {
    description: 'WhatsApp Business API credentials',
    fields: {
      phone_number_id: { type: 'string', required: true, example: '1178426052021435' },
      waba_id_production: { type: 'string', required: true, example: '3468717666623916' },
      access_token: { type: 'string', required: true },
    },
  },
  telegram_bot: {
    description: 'Telegram bot credentials',
    fields: {
      bot_token: { type: 'string', required: true },
      admin_chat_id: { type: 'string', required: true },
    },
  },
  gemini_api: {
    description: 'Google Gemini API credentials',
    fields: {
      api_key: { type: 'string', required: true },
    },
  },
  anthropic_api: {
    description: 'Anthropic (Claude) API credentials',
    fields: {
      api_key: { type: 'string', required: true },
    },
  },
};

const VALID_CATEGORIES = Object.keys(CREDENTIAL_SCHEMAS);

function isValidCategory(category) {
  return VALID_CATEGORIES.includes(category);
}

function validateCredentialShape(category, data) {
  if (!isValidCategory(category)) {
    throw new Error(`Unknown credential category: ${category}`);
  }

  const schema = CREDENTIAL_SCHEMAS[category];
  const missing = Object.entries(schema.fields)
    .filter(([, field]) => field.required)
    .filter(([name]) => data[name] === undefined || data[name] === null || data[name] === '')
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing required fields for ${category}: ${missing.join(', ')}`);
  }
}

module.exports = {
  COLLECTION,
  CREDENTIAL_SCHEMAS,
  VALID_CATEGORIES,
  isValidCategory,
  validateCredentialShape,
};
