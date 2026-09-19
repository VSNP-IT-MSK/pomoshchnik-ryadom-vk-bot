const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const BRAND_STYLE = `
Фирменная стилистика ВСНП Москва: палитра #B88FFF (лавандовый), #7F74D8 (фиолетовый),
#FFD21F (жёлтый акцент), #29747D и #0C4746 (глубокий бирюзовый), белый.
Графический язык — мягкие текучие линии и волнообразные формы, четыре тонких
конца звезды как знак вдохновения и открытых возможностей. Используй много воздуха,
современную редакционную фотографию, естественный свет, живых людей и атмосферу
поддержки и роста. Оставляй свободную область сверху или слева для заголовка.
Не добавляй читаемый текст, водяные знаки и чужие логотипы.`.trim();

const BUTTON = Object.freeze({
  START: "Новый пост",
  HELP: "Помощь",
  CANCEL: "Отмена"
});

const VK_KEYBOARD = {
  one_time: false,
  buttons: [
    [
      { action: { type: "text", label: BUTTON.START, payload: JSON.stringify({ action: "start" }) }, color: "primary" },
      { action: { type: "text", label: BUTTON.HELP, payload: JSON.stringify({ action: "help" }) }, color: "secondary" },
      { action: { type: "text", label: BUTTON.CANCEL, payload: JSON.stringify({ action: "cancel" }) }, color: "negative" }
    ]
  ]
};

// Render free runs one Node process. Keep the short-lived two-message draft in memory.
const pendingDrafts = new Map();

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "vsnp-vk-bot" }), { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Помощник рядом bot is running", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/cron/daily") {
      return new Response("automatic publication is disabled; send text and photo to the bot", { status: 410 });
    }

    if (request.method !== "POST") return new Response("method not allowed", { status: 405 });

    let payload;
    try {
      payload = await request.json();
    } catch {
      return new Response("invalid json", { status: 400 });
    }

    if (env.VK_GROUP_ID && payload.group_id && String(payload.group_id) !== String(env.VK_GROUP_ID)) {
      return new Response("forbidden", { status: 403 });
    }

    if (payload.type === "confirmation") {
      // VK's confirmation request contains only type and group_id.
      return new Response(env.VK_CONFIRMATION_CODE || "", { headers: { "content-type": "text/plain; charset=utf-8" } });
    }

    if (env.VK_CALLBACK_SECRET && payload.secret !== env.VK_CALLBACK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    // VK can retry a callback. KV is optional; when configured it prevents duplicate posts.
    if (payload.event_id && env.EVENTS) {
      const seen = await env.EVENTS.get(`event:${payload.event_id}`);
      if (seen) return new Response("ok");
      ctx.waitUntil(env.EVENTS.put(`event:${payload.event_id}`, "1", { expirationTtl: 86400 }));
    }

    if (payload.type === "message_new") {
      ctx.waitUntil(Promise.resolve(handleMessage(payload, env))
        .catch((error) => console.error("message_new failed", error)));
    }

    return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

async function handleMessage(payload, env) {
  const message = payload.object?.message || payload.object || {};
  const peerId = Number(message.peer_id || message.from_id);
  const fromId = Number(message.from_id || peerId);
  const text = String(message.text || "").trim();
  if (!peerId) return;

  const command = text.replace(/^\s+/, "");
  const buttonAction = getButtonAction(message);

  if (buttonAction === "help" || /^(?:\/help|помощь|начать)$/iu.test(command)) {
    await sendMessage(peerId, "Пришлите текст поста и отдельно оригинальное фото. Я улучшу текст, оформлю фото в фирменной стилистике и верну готовый пост сюда.", env);
    return;
  }

  if (buttonAction === "cancel" || /^отмена$/iu.test(command)) {
    pendingDrafts.delete(peerId);
    await sendMessage(peerId, "Действие отменено.", env);
    return;
  }

  if (buttonAction === "start" || /^новый пост$/iu.test(command)) {
    pendingDrafts.set(peerId, { createdAt: Date.now() });
    await sendMessage(peerId, "Пришлите текст поста и отдельно оригинальное фото. Можно отправить их в любом порядке.", env);
    return;
  }

  if (!isAdmin(fromId, env)) {
    await sendMessage(peerId, "Обработка постов доступна администратору сообщества.", env);
    return;
  }

  let photo;
  try {
    photo = await extractPhoto(message);
  } catch (error) {
    console.error(error);
    await sendMessage(peerId, "Не удалось получить фото из сообщения. Пришлите оригинал ещё раз.", env);
    return;
  }

  const pending = pendingDrafts.get(peerId) || { createdAt: Date.now() };
  if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
    pending.text = "";
    pending.photo = null;
    pending.createdAt = Date.now();
  }
  const legacyCommand = /^\/(?:help|daily|publish|post)\b/iu.test(command);
  if (text && !legacyCommand) pending.text = text;
  if (photo) pending.photo = photo;
  pendingDrafts.set(peerId, pending);

  if (!pending.text && !pending.photo) {
    pendingDrafts.delete(peerId);
    await sendMessage(peerId, "Пришлите текст поста и оригинальное фото. Их можно отправить в любом порядке.", env);
    return;
  }

  if (!pending.text) {
    await sendMessage(peerId, "Фото принял. Теперь пришлите текст поста отдельным сообщением.", env);
    return;
  }
  if (!pending.photo) {
    await sendMessage(peerId, "Текст принял. Теперь пришлите оригинальное фото отдельным сообщением.", env);
    return;
  }

  pendingDrafts.delete(peerId);
  await createPostFromDraft(peerId, fromId, pending, env);
}

function getButtonAction(message) {
  try {
    const payload = typeof message.payload === "string" ? JSON.parse(message.payload) : message.payload;
    return payload?.action || null;
  } catch {
    return null;
  }
}

async function createPostFromDraft(peerId, fromId, draft, env) {
  if (!isAdmin(fromId, env)) {
    await sendMessage(peerId, "Обработка постов доступна администратору сообщества.", env);
    return;
  }
  await sendMessage(peerId, "Обрабатываю текст и фото в фирменном стиле…", env);
  try {
    const result = await improveDraft(draft, peerId, env);
    await sendMessage(peerId, formatPost(result), env, result.attachment);
  } catch (error) {
    console.error(error);
    await sendMessage(peerId, `Не удалось обработать пост: ${error.message || "ошибка сервиса"}`, env);
  }
}

const MAX_VISION_IMAGE_BYTES = 6 * 1024 * 1024;

async function extractPhoto(message) {
  const attachments = normalizeAttachments(message?.attachments);
  const attachment = attachments.find((item) => item?.type === "photo" && item.photo);
  if (!attachment) return null;

  const photo = attachment.photo;
  const candidates = [];
  const seen = new Set();
  const addCandidate = (url, width = 0, height = 0) => {
    if (!url || typeof url !== "string" || seen.has(url)) return;
    seen.add(url);
    candidates.push({ url, width: Number(width) || 0, height: Number(height) || 0 });
  };

  for (const size of Array.isArray(photo.sizes) ? photo.sizes : []) {
    addCandidate(size?.url, size?.width, size?.height);
  }
  if (photo.orig_photo) addCandidate(photo.orig_photo.url, photo.orig_photo.width, photo.orig_photo.height);
  addCandidate(photo.url, photo.width, photo.height);
  for (const [key, value] of Object.entries(photo)) {
    if (/^photo_\d+$/.test(key)) addCandidate(value, Number(key.slice(6)), 0);
  }

  candidates.sort((a, b) => (b.width * b.height || b.width) - (a.width * a.height || a.width));
  if (!candidates.length) throw new Error("в сообщении нет доступного URL фотографии");

  let fallback = null;
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate.url);
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) continue;
      const mime = imageMime(response.headers.get("content-type"), candidate.url);
      const result = { bytes, mime, width: candidate.width, height: candidate.height };
      fallback = result;
      if (bytes.byteLength <= MAX_VISION_IMAGE_BYTES) return result;
    } catch {
      // Try a smaller VK size if the largest URL has expired or is unavailable.
    }
  }
  if (fallback) return fallback;
  throw new Error("не удалось скачать фотографию из VK");
}

function normalizeAttachments(value) {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function imageMime(contentType, url) {
  const fromHeader = String(contentType || "").split(";", 1)[0].trim().toLowerCase();
  if (fromHeader.startsWith("image/")) return fromHeader;
  const extension = String(url).split("?", 1)[0].match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase();
  return extension === "png" ? "image/png" : extension === "webp" ? "image/webp" : "image/jpeg";
}

function isAdmin(userId, env) {
  return String(env.ADMIN_VK_IDS || "").split(",").map((x) => x.trim()).filter(Boolean).includes(String(userId));
}

async function improveDraft(draft, peerId, env) {
  if (!draft?.text || !draft?.photo?.bytes?.length) {
    throw new Error("нужны и текст, и исходное фото");
  }

  const communityName = env.COMMUNITY_NAME || "Помощник рядом";
  const imageDataUrl = bytesToDataUrl(draft.photo.bytes, draft.photo.mime);
  const prompt = `Подготовь готовый пост для сообщества «${communityName}» по исходному тексту пользователя и приложенной фотографии.\n\n` +
    `Исходный текст пользователя:\n---\n${draft.text}\n---\n\n` +
    `Аудитория: подростки и молодые люди, наставники, родители и специалисты помогающих профессий в Москве. ` +
    `Сохрани все проверяемые факты из исходного текста и не выдумывай даты, имена, адреса, цифры, условия, ` +
    `партнёров или результаты. Можно исправить язык, порядок мыслей и ритм, но нельзя менять смысл. ` +
    `Сделай короткий ясный заголовок, 2–4 абзаца с одной практической мыслью, бережный тон без назидательности ` +
    `и конкретный мягкий призыв к диалогу в конце.\n\n` +
    `Проанализируй фотографию и составь image_prompt на английском для фотореалистичной стилизации именно ` +
    `этого исходника: сохрани узнаваемых людей, важные предметы, действие и общий сюжет, не добавляй ` +
    `вымышленных людей или событий. Опиши аккуратную редакционную обработку, свет, композицию и свободную ` +
    `зону под заголовок; не добавляй читаемый текст, водяные знаки или чужие логотипы. Визуальный промпт ` +
    `должен учитывать фирменную стилистику ниже.\n\n${BRAND_STYLE}\n\n` +
    `Верни только JSON без markdown-обёртки с полями: title, text, image_prompt, hashtags. ` +
    `hashtags — массив из 2–4 коротких хэштегов на русском.`;

  const data = await openAI("/chat/completions", {
    model: env.TEXT_MODEL || "gpt-5.6-luna",
    temperature: 0.55,
    messages: [
      {
        role: "system",
        content: `Ты внимательный редактор сообщества «${communityName}». Пиши ясно, тепло и конкретно. ` +
          "Точность исходных фактов важнее выразительности."
      },
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: imageDataUrl } }
        ]
      }
    ]
  }, env);

  const raw = messageContentToText(data.choices?.[0]?.message?.content);
  const parsed = parseJson(raw || "{}");
  if (!parsed.title || !parsed.text || !parsed.image_prompt) {
    throw new Error("модель вернула неполный пост");
  }

  const post = {
    title: String(parsed.title).trim(),
    text: String(parsed.text).trim(),
    image_prompt: `${String(parsed.image_prompt).trim()}. ${BRAND_STYLE}`,
    hashtags: normalizeHashtags(parsed.hashtags)
  };
  const imageBytes = await generateImage(post.image_prompt, env);
  post.attachment = await uploadMessagePhoto(imageBytes, peerId, env);
  return post;
}

async function generateImage(prompt, env) {
  const data = await openAI("/images/generations", {
    model: env.IMAGE_MODEL || "gpt-image-2",
    prompt,
    size: "1024x1024",
    quality: "auto",
    response_format: "b64_json"
  }, env);
  const item = data.data?.[0];
  if (!item) throw new Error("модель изображения не вернула файл");
  if (item.b64_json) return base64ToBytes(item.b64_json);
  if (item.url) {
    const response = await fetch(item.url);
    if (!response.ok) throw new Error(`не удалось скачать изображение (${response.status})`);
    return new Uint8Array(await response.arrayBuffer());
  }
  throw new Error("неизвестный формат изображения");
}

async function openAI(path, body, env) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY не задан");
  const base = (env.OPENAI_BASE_URL || "https://api.smartapi.shop/v1").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `AI API ${response.status}`);
  return data;
}

async function uploadMessagePhoto(bytes, peerId, env) {
  const server = await vk("photos.getMessagesUploadServer", { peer_id: peerId }, env);
  const form = new FormData();
  const mime = detectImageMime(bytes);
  const extension = mime === "image/jpeg" ? "jpg" : mime === "image/gif" ? "gif" : "png";
  form.append("photo", new Blob([bytes], { type: mime }), `pomoshchnik-post.${extension}`);
  const uploadResponse = await fetch(server.upload_url, { method: "POST", body: form });
  const upload = await uploadResponse.json().catch(() => ({}));
  if (!uploadResponse.ok) throw new Error(upload.error || `VK загрузка изображения ${uploadResponse.status}`);
  if (!upload.photo) throw new Error("VK не принял изображение для сообщения");
  const saved = await vk("photos.saveMessagesPhoto", { photo: upload.photo, server: upload.server, hash: upload.hash }, env);
  const photo = saved[0];
  if (!photo) throw new Error("VK не сохранил изображение для сообщения");
  return `photo${photo.owner_id}_${photo.id}`;
}

async function sendMessage(peerId, message, env, attachment = "") {
  const params = {
    peer_id: peerId,
    random_id: Math.floor(Math.random() * 2_000_000_000),
    message,
    keyboard: JSON.stringify(VK_KEYBOARD)
  };
  if (attachment) params.attachment = attachment;
  return vk("messages.send", params, env);
}

async function vk(method, params, env, accessToken = env.VK_GROUP_TOKEN) {
  if (!accessToken) throw new Error("VK-токен не задан");
  const body = new URLSearchParams({ ...params, access_token: accessToken, v: env.VK_API_VERSION || "5.199" });
  const response = await fetch(`https://api.vk.com/method/${method}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  const data = await response.json();
  if (data.error) throw new Error(data.error.error_msg || `VK API ${data.error.error_code}`);
  return data.response;
}

function formatPost(post) {
  const tags = (post.hashtags || []).join(" ");
  return `${post.title}\n\n${post.text}${tags ? `\n\n${tags}` : ""}`.trim();
}

function parseJson(value) {
  const cleaned = String(value).replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
  try { return JSON.parse(cleaned); } catch {
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(cleaned.slice(start, end + 1));
    throw new Error("не удалось разобрать JSON от текстовой модели");
  }
}

function messageContentToText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part) => {
      if (typeof part === "string") return part;
      return part?.text || part?.content || "";
    }).join("");
  }
  return content?.text || content?.content || "";
}

function normalizeHashtags(value) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const hashtags = [];
  for (const item of source) {
    const tag = String(item || "").trim().replace(/^#+/, "");
    if (!tag) continue;
    const normalized = `#${tag.replace(/[^\p{L}\p{N}_-]/gu, "")}`;
    if (normalized.length > 1 && !hashtags.includes(normalized)) hashtags.push(normalized);
    if (hashtags.length >= 6) break;
  }
  return hashtags.length ? hashtags : ["#ПомощникРядом", "#Москва"];
}

function bytesToDataUrl(bytes, mime = "image/jpeg") {
  return `data:${imageMime(mime, "")};base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes) {
  if (typeof Buffer !== "undefined") return Buffer.from(bytes).toString("base64");
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function detectImageMime(bytes) {
  if (bytes?.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes?.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  return "image/png";
}

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
