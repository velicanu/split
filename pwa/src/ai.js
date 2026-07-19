// Receipt scanning. The browser calls the user's chosen provider directly with
// their own key — the server only stores the key, it never proxies the call.
//
// Anthropic supports this officially via the
// `anthropic-dangerous-direct-browser-access` header (added for exactly this
// bring-your-own-key case). OpenAI has no documented browser support; its API
// does return CORS headers in practice, but that could change, so a blocked
// request gets an explanatory error rather than a mystery failure.

export const PROVIDERS = {
  anthropic: {
    label: 'Anthropic',
    models: [
      { id: 'claude-haiku-4-5', label: 'Haiku 4.5', price: '$1 / $5 per Mtok' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5', price: '$3 / $15' },
      { id: 'claude-opus-4-8', label: 'Opus 4.8', price: '$5 / $25' },
    ],
  },
  openai: {
    label: 'OpenAI',
    models: [
      { id: 'gpt-5.4-nano', label: 'GPT-5.4 nano', price: '$0.20 / $1.25 per Mtok' },
      { id: 'gpt-5.4-mini', label: 'GPT-5.4 mini', price: '$0.75 / $4.50' },
      { id: 'gpt-5.6-luna', label: 'GPT-5.6 luna', price: '$1 / $6' },
      { id: 'gpt-5.4', label: 'GPT-5.4', price: '$2.50 / $15' },
    ],
  },
}

const PROMPT = [
  'Extract the line items and the final total from this receipt.',
  'Amounts are integer cents: $4.50 is 450.',
  'items: one entry per purchased line item. Do NOT include subtotal, tax,',
  'tip, or total lines as items.',
  'total_cents: the final amount actually charged, after tax, tip and discounts.',
].join(' ')

const SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          price_cents: { type: 'integer' },
        },
        required: ['name', 'price_cents'],
        additionalProperties: false,
      },
    },
    total_cents: { type: 'integer' },
  },
  required: ['items', 'total_cents'],
  additionalProperties: false,
}

// Receipts are tall; shrinking before upload cuts image tokens (and cost)
// substantially without hurting legibility much.
export async function prepareImage(file, maxEdge = 1500, quality = 0.8) {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height))
  const width = Math.round(bitmap.width * scale)
  const height = Math.round(bitmap.height * scale)
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
  const dataUrl = canvas.toDataURL('image/jpeg', quality)
  return { dataUrl, base64: dataUrl.split(',')[1], mediaType: 'image/jpeg' }
}

async function failure(res, provider) {
  let detail = ''
  try {
    const body = await res.json()
    detail = body?.error?.message || body?.message || ''
  } catch {
    // non-JSON error body
  }
  if (res.status === 401 || res.status === 403) {
    return new Error(`${provider} rejected the API key (${res.status})`)
  }
  return new Error(`${provider} error ${res.status}${detail ? `: ${detail}` : ''}`)
}

async function callAnthropic({ apiKey, model, base64, mediaType }) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model,
      max_tokens: 2048,
      output_config: { format: { type: 'json_schema', schema: SCHEMA } },
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: mediaType, data: base64 },
            },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    }),
  })
  if (!res.ok) throw await failure(res, 'Anthropic')
  const data = await res.json()
  const text = (data.content || []).find((b) => b.type === 'text')?.text
  if (!text) throw new Error('Anthropic returned no text content')
  return JSON.parse(text)
}

async function callOpenAI({ apiKey, model, dataUrl }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: {
        type: 'json_schema',
        json_schema: { name: 'receipt', strict: true, schema: SCHEMA },
      },
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: dataUrl } },
          ],
        },
      ],
    }),
  })
  if (!res.ok) throw await failure(res, 'OpenAI')
  const data = await res.json()
  const text = data.choices?.[0]?.message?.content
  if (!text) throw new Error('OpenAI returned no content')
  return JSON.parse(text)
}

// Trust nothing: the model can return the right shape with junk in it.
function normalize(raw) {
  const items = Array.isArray(raw?.items) ? raw.items : []
  const clean = items
    .map((it) => ({
      name: String(it?.name ?? '').trim(),
      price_cents: Math.round(Number(it?.price_cents)),
    }))
    .filter((it) => Number.isFinite(it.price_cents) && it.price_cents > 0)
  const total = Math.round(Number(raw?.total_cents))
  const itemsTotal = clean.reduce((t, it) => t + it.price_cents, 0)
  return {
    items: clean,
    // Fall back to the items subtotal if the model didn't give a usable total.
    total_cents: Number.isFinite(total) && total > 0 ? total : itemsTotal,
  }
}

export async function extractReceipt({ provider, apiKey, model, file }) {
  const image = await prepareImage(file)
  try {
    const raw =
      provider === 'anthropic'
        ? await callAnthropic({ apiKey, model, ...image })
        : await callOpenAI({ apiKey, model, ...image })
    const result = normalize(raw)
    if (!result.items.length) throw new Error('No line items found on that image')
    return result
  } catch (err) {
    // A CORS/network block rejects before any response, as a TypeError.
    if (err instanceof TypeError) {
      throw new Error(
        provider === 'openai'
          ? "Couldn't reach OpenAI from the browser. OpenAI doesn't officially" +
            ' support direct browser calls, so they can be blocked — try an' +
            ' Anthropic key instead.'
          : "Couldn't reach Anthropic from the browser — check your connection."
      )
    }
    throw err
  }
}
