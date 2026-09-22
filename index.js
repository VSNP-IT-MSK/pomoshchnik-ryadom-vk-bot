import { fileURLToPath } from "node:url";
import sharp from "sharp";

const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };
const BRAND_LOGO_PATH = fileURLToPath(new URL("./assets/brand-logo.png", import.meta.url));

const BRAND_STYLE = `
Фирменная стилистика ВСНП Москва: палитра #B88FFF (лавандовый), #7F74D8 (фиолетовый),
#FFD21F (жёлтый акцент), #29747D и #0C4746 (глубокий бирюзовый), белый.
Графический язык — мягкие текучие линии и волнообразные формы, четыре тонких
конца звезды как знак вдохновения и открытых возможностей. Используй много воздуха,
современную редакционную фотографию, естественный свет, живых людей и атмосферу
поддержки и роста. Оставляй свободную область сверху или слева для заголовка.
Не добавляй читаемый текст, водяные знаки и чужие логотипы.`.trim();

const BOT_DISPLAY_NAME = "ВСНП помощь";
const DEFAULT_REQUIRED_HASHTAGS = ["#ВСНП_МОСКВА", "#Наставничество", "#Просвещение", "#Москва"];

const BUTTON = Object.freeze({
  START: "Новый пост",
  HELP: "Помощь",
  CANCEL: "Отмена"
});

const MAX_KEYBOARD = {
  type: "inline_keyboard",
  payload: {
    buttons: [[
      { type: "callback", text: BUTTON.START, payload: "start" },
      { type: "callback", text: BUTTON.HELP, payload: "help" },
      { type: "callback", text: BUTTON.CANCEL, payload: "cancel" }
    ]]
  }
};

// Cloud.ru container runs one Node process. Keep the short-lived two-message draft in memory.
const pendingDrafts = new Map();
const seenMaxEvents = new Map();

function draftKey(peerId, fromId) {
  return `${peerId}:${fromId}`;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "vsnp-pomosh-max-bot", bot_name: BOT_DISPLAY_NAME, transport: "max" }), { headers: JSON_HEADERS });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(`${BOT_DISPLAY_NAME} bot is running`, { headers: { "content-type": "text/plain; charset=utf-8" } });
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

    const webhookSecret = request.headers.get("x-max-bot-api-secret");
    if (env.MAX_WEBHOOK_SECRET && webhookSecret !== env.MAX_WEBHOOK_SECRET) {
      return new Response("forbidden", { status: 403 });
    }

    const updateType = String(payload.update_type || payload.type || "");
    if (updateType === "message_created" || updateType === "message_callback" || updateType === "bot_started") {
      const eventId = payload.update_id || payload.event_id || payload.callback?.callback_id;
      if (eventId && rememberMaxEvent(eventId)) return new Response("ok");
      const normalized = normalizeMaxUpdate(payload);
      if (normalized) {
        // MAX sends bot_started without a message body. Treat it as the
        // built-in "Новый пост" action so a new dialog gets its keyboard.
        if (updateType === "bot_started") normalized.message.text = BUTTON.START;
        ctx.waitUntil(Promise.resolve(handleMessage(normalized, env))
          .catch((error) => console.error(`${updateType} failed`, error)));
      }
    }

    return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

function rememberMaxEvent(eventId) {
  const key = String(eventId);
  const now = Date.now();
  for (const [oldKey, timestamp] of seenMaxEvents) {
    if (now - timestamp > 24 * 60 * 60 * 1000) seenMaxEvents.delete(oldKey);
  }
  if (seenMaxEvents.has(key)) return true;
  seenMaxEvents.set(key, now);
  return false;
}

function normalizeMaxUpdate(update) {
  const callback = update.callback || update.message_callback || {};
  const source = update.message || callback.message || {};
  const body = source.body || source;
  const sender = source.sender || callback.user || update.user || update.sender || {};
  const recipient = source.recipient || {};
  const chatId = recipient.chat_id ?? source.chat_id ?? callback.chat_id ?? update.chat_id;
  const senderUserId = sender.user_id ?? callback.user?.user_id ?? callback.user_id ?? source.user_id ?? update.user_id ?? update.user?.user_id;
  const peerId = chatId !== undefined && chatId !== null
    ? `chat:${chatId}`
    : senderUserId !== undefined && senderUserId !== null
      ? `user:${senderUserId}`
      : "";
  if (!peerId) return null;

  const attachments = normalizeMaxAttachments(body.attachments || source.attachments);
  const callbackPayload = callback.payload ?? callback.callback_data ?? body.payload ?? source.payload;
  return {
    message: {
      peer_id: peerId,
      from_id: senderUserId || peerId,
      text: String(body.text ?? source.text ?? "").trim(),
      payload: callbackPayload,
      attachments
    }
  };
}

function normalizeMaxAttachments(value) {
  const attachments = normalizeAttachments(value);
  return attachments.map((attachment) => {
    const type = String(attachment?.type || "").toLowerCase();
    if (type !== "image" && type !== "photo") return attachment;
    const payload = attachment.payload || attachment;
    const candidates = collectImageUrls(payload);
    return {
      type: "photo",
      photo: {
        sizes: candidates.map((url, index) => ({ url, width: index + 1 }))
      }
    };
  });
}

function collectImageUrls(value) {
  const urls = [];
  const seen = new Set();
  const visit = (item, key = "") => {
    if (!item) return;
    if (typeof item === "string") {
      if (/^https?:\/\//i.test(item) && (!key || /url|image|photo|preview|download|src/i.test(key))) {
        if (!seen.has(item)) { seen.add(item); urls.push(item); }
      }
      return;
    }
    if (Array.isArray(item)) { item.forEach((entry) => visit(entry, key)); return; }
    if (typeof item !== "object") return;
    for (const [childKey, childValue] of Object.entries(item)) visit(childValue, childKey);
  };
  visit(value);
  return urls;
}

async function handleMessage(payload, env) {
  const message = payload.object?.message || payload.object || payload.message || {};
  const peerId = message.peer_id || message.chat_id || message.user_id || message.from_id;
  const fromId = message.from_id || peerId;
  const text = String(message.text || "").trim();
  if (!peerId) return;
  const key = draftKey(peerId, fromId);

  const command = text.replace(/^\s+/, "");
  const buttonAction = getButtonAction(message);

  if (buttonAction === "help" || /^(?:\/help|помощь|начать)$/iu.test(command)) {
    await sendMessage(peerId, "Пришлите текст поста и отдельно оригинальное фото. Я улучшу текст, оформлю фото в фирменной стилистике и верну готовый пост сюда.", env);
    return;
  }

  if (buttonAction === "cancel" || /^отмена$/iu.test(command)) {
    pendingDrafts.delete(key);
    await sendMessage(peerId, "Действие отменено.", env);
    return;
  }

  if (buttonAction === "start" || /^новый пост$/iu.test(command)) {
    pendingDrafts.set(key, { createdAt: Date.now() });
    await sendMessage(peerId, "Пришлите текст поста и отдельно оригинальное фото. Можно отправить их в любом порядке. После обработки проверьте факты перед публикацией.", env);
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

  const pending = pendingDrafts.get(key) || { createdAt: Date.now() };
  if (Date.now() - pending.createdAt > 15 * 60 * 1000) {
    pending.text = "";
    pending.photo = null;
    pending.createdAt = Date.now();
  }
  const legacyCommand = /^\/(?:help|daily|publish|post)\b/iu.test(command);
  if (text && !legacyCommand) pending.text = text;
  if (photo) pending.photo = photo;
  pendingDrafts.set(key, pending);

  if (!pending.text && !pending.photo) {
    pendingDrafts.delete(key);
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

  pendingDrafts.delete(key);
  await createPostFromDraft(peerId, fromId, pending, env);
}

function getButtonAction(message) {
  try {
    const raw = message.payload;
    const payload = typeof raw === "string" ? (() => {
      try { return JSON.parse(raw); } catch { return raw; }
    })() : raw;
    if (typeof payload === "string") return payload;
    return payload?.action || payload?.command || null;
  } catch {
    return null;
  }
}

async function createPostFromDraft(peerId, fromId, draft, env) {
  await sendMessage(peerId, "Обрабатываю текст и фото в фирменном стиле…", env);
  try {
    const result = await improveDraft(draft, peerId, env);
    await sendMessage(peerId, formatPost(result), env, result.attachment);
  } catch (error) {
    console.error(error);
    await sendMessage(peerId, `Не удалось обработать пост: ${userFacingError(error)}`, env);
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
      const response = await fetchWithRetry(candidate.url, {}, {
        attempts: 2,
        timeoutMs: 20000,
        logRetries: false
      });
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (!bytes.length) continue;
      const mime = imageMime(response.headers.get("content-type"), candidate.url);
      const result = { bytes, mime, width: candidate.width, height: candidate.height };
      fallback = result;
      if (bytes.byteLength <= MAX_VISION_IMAGE_BYTES) return result;
    } catch {
      // Try a smaller image URL if the largest one has expired or is unavailable.
    }
  }
  if (fallback) return fallback;
  throw new Error("не удалось скачать фотографию из MAX");
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

async function improveDraft(draft, peerId, env) {
  if (!draft?.text || !draft?.photo?.bytes?.length) {
    throw new Error("нужны и текст, и исходное фото");
  }

  const communityName = "ВСНП_МОСКВА";
  const mandatoryHashtags = normalizeHashtags([], env).join(" ");
  const prompt = `Подготовь готовый пост для группы «${communityName}» по исходному тексту пользователя. Фотография ` +
    `будет оформлена отдельно локальным слоем брендинга.\n\n` +
    `Исходный текст пользователя:\n---\n${draft.text}\n---\n\n` +
    `Пиши для аудитории группы: наставники-просветители, педагоги, кураторы, добровольцы, родители, подростки и ` +
    `молодые люди, а также партнёры образовательных и социальных инициатив Москвы. Группа рассказывает о ` +
    `встречах, форумах, конкурсах, сетевых проектах, книгах, просветительских практиках и людях, которые ` +
    `помогают учиться, развиваться и поддерживать друг друга.\n\n` +
    `Редакционная логика группы: начни с короткого заголовка или живого захода; затем объясни, что произошло ` +
    `или что предстоит, укажи проверяемые детали (дата, место, участники, организаторы, ссылка), добавь, почему ` +
    `это важно читателю, и закончи доброжелательным приглашением присоединиться, узнать больше или поделиться ` +
    `опытом. Для отчёта о событии используй факты и человеческую деталь; для анонса — ясную пользу и условия; ` +
    `для поздравления — конкретный повод и признательность.\n\n` +
    `Сохрани все проверяемые факты из исходного текста и не выдумывай даты, имена, адреса, цифры, условия, ` +
    `партнёров, цитаты или результаты. Если детали не указаны, не подставляй догадки и не выдавай предположение ` +
    `за факт. Можно исправить язык, порядок мыслей и ритм, но нельзя менять смысл. Пиши по-русски, тепло, ` +
    `конкретно и без канцелярита, громких рекламных обещаний и назидательности. Эмодзи используй редко и только ` +
    `если они поддерживают исходный тон.\n\n` +
    `Сделай заголовок длиной примерно 5–10 слов, затем 2–5 коротких абзацев и один мягкий призыв к диалогу ` +
    `или действию. Не начинай каждый абзац одинаково и не повторяй заголовок в тексте.\n\n` +
    `Хэштеги: обязательно добавь в конец поста следующие теги: ${mandatoryHashtags}. Сохрани хэштеги пользователя и названия проектов в их исходном написании, включая подчёркивания ` +
    `(например, #Почитаем_2026). Если исходных хэштегов нет, добавь 2–4 точных тематических тега про наставничество, ` +
    `просвещение, образование, событие или Москву. Не используй рекламный спам, общие теги вроде #успех и не ` +
    `придумывай название проекта.\n\n` +
    `Фото не нужно анализировать или пересоздавать: его обработает локальный слой брендинга. Опиши в image_prompt ` +
    `на английском только рекомендации по фирменному оформлению поверх исходника. ` +
    `Исходная фотография должна остаться узнаваемой: те же лица, люди, предметы, действие и композиция. ` +
    `Нельзя перерисовывать людей, менять лица, добавлять людей, заменять фон или создавать новую сцену. ` +
    `Фактическую обработку выполнит слой брендинга: логотип, аккуратные текучие волны, четыре тонких ` +
    `конца звезды и цветовые акценты. Не добавляй читаемый текст, кроме предоставленного логотипа. ` +
    `Учитывай фирменную стилистику ниже.\n\n${BRAND_STYLE}\n\n` +
    `Верни только JSON без markdown-обёртки с полями: title, text, image_prompt, hashtags. ` +
    `hashtags — массив из 2–4 коротких хэштегов на русском.`;

  const data = await openAI("/chat/completions", {
    model: env.TEXT_MODEL || "gpt-5.6-luna",
    temperature: 0.55,
    messages: [
      {
        role: "system",
        content: `Ты внимательный редактор группы «${communityName}». Пиши ясно, тепло и конкретно в стиле ` +
          "публичных постов о наставниках, просвещении, событиях и образовательных инициативах Москвы. " +
          "Точность исходных фактов важнее выразительности."
      },
      { role: "user", content: prompt }
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
    hashtags: normalizeHashtags(parsed.hashtags, env)
  };
  const imageBytes = await applyBrandDesign(draft.photo.bytes);
  post.attachment = await uploadMessagePhoto(imageBytes, peerId, env);
  return post;
}

async function applyBrandDesign(bytes) {
  const base = await sharp(bytes, { failOn: "none" })
    .rotate()
    .resize({ width: 1600, height: 1600, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: 94, chromaSubsampling: "4:4:4" })
    .toBuffer();
  const metadata = await sharp(base).metadata();
  const width = metadata.width || 1600;
  const height = metadata.height || 1600;
  const margin = Math.max(18, Math.round(width * 0.025));
  const maxLogoWidth = Math.max(32, width - margin * 2);
  const logoWidth = Math.min(maxLogoWidth, Math.max(96, Math.round(width * 0.2)));
  const logo = await sharp(BRAND_LOGO_PATH)
    .resize({ width: logoWidth, fit: "inside", withoutEnlargement: false })
    .png()
    .toBuffer();
  const waveHeight = Math.round(height * 0.16);
  const stroke = Math.max(4, Math.round(width * 0.006));
  const overlay = Buffer.from(`<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
    <path d="M0 ${height - waveHeight * 0.72} C ${width * 0.2} ${height - waveHeight * 1.2}, ${width * 0.36} ${height - waveHeight * 0.05}, ${width * 0.58} ${height - waveHeight * 0.62} S ${width * 0.86} ${height - waveHeight * 1.05}, ${width} ${height - waveHeight * 0.48} L ${width} ${height} L 0 ${height} Z" fill="#0C4746" fill-opacity="0.72"/>
    <path d="M0 ${height - waveHeight * 0.3} C ${width * 0.2} ${height - waveHeight * 0.75}, ${width * 0.4} ${height + waveHeight * 0.05}, ${width * 0.63} ${height - waveHeight * 0.28} S ${width * 0.86} ${height - waveHeight * 0.7}, ${width} ${height - waveHeight * 0.18}" fill="none" stroke="#B88FFF" stroke-width="${stroke}" stroke-linecap="round" opacity="0.95"/>
    <path d="M0 ${height - waveHeight * 0.08} C ${width * 0.24} ${height - waveHeight * 0.38}, ${width * 0.47} ${height + waveHeight * 0.08}, ${width * 0.75} ${height - waveHeight * 0.12} S ${width * 0.9} ${height - waveHeight * 0.34}, ${width} ${height - waveHeight * 0.1}" fill="none" stroke="#FFD21F" stroke-width="${Math.max(3, Math.round(stroke * 0.65))}" stroke-linecap="round" opacity="0.96"/>
    <rect x="${margin - 8}" y="${margin - 8}" width="${logoWidth + 16}" height="${Math.round(logoWidth * 0.82) + 16}" rx="${Math.round(margin * 0.7)}" fill="#FFFFFF" fill-opacity="0.78"/>
    <path d="M${width - margin * 2.5} ${margin * 1.2} C ${width - margin * 1.5} ${margin * 0.2}, ${width - margin * 0.5} ${margin * 1.9}, ${width - margin * 0.4} ${margin * 0.7}" fill="none" stroke="#7F74D8" stroke-width="${stroke}" stroke-linecap="round" opacity="0.9"/>
    <path d="M${width - margin * 1.7} ${margin * 1.15} C ${width - margin * 1.2} ${margin * 0.55}, ${width - margin * 0.7} ${margin * 1.35}, ${width - margin * 0.2} ${margin * 0.95}" fill="none" stroke="#FFD21F" stroke-width="${Math.max(3, Math.round(stroke * 0.7))}" stroke-linecap="round" opacity="0.95"/>
  </svg>`);
  return sharp(base)
    .composite([
      { input: overlay, left: 0, top: 0 },
      { input: logo, left: margin, top: margin }
    ])
    .jpeg({ quality: 92, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

async function openAI(path, body, env) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY не задан");
  const base = (env.OPENAI_BASE_URL || "https://api.smartapi.shop/v1").replace(/\/$/, "");
  const response = await fetchWithRetry(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  }, { attempts: 1, timeoutMs: 60000 });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `AI API ${response.status}`);
  return data;
}

async function uploadMessagePhoto(bytes, peerId, env) {
  return uploadMaxImage(bytes, env);
}

async function sendMessage(peerId, message, env, attachment = "") {
  return sendMaxMessage(peerId, message, env, attachment);
}

async function sendMaxMessage(peerId, message, env, attachment = null) {
  const target = parseMaxTarget(peerId);
  if (!target.id) throw new Error("MAX не определил получателя сообщения");
  const queryName = target.type === "user" ? "user_id" : "chat_id";
  const attachments = [];
  if (attachment) attachments.push(attachment);
  attachments.push(MAX_KEYBOARD);
  return maxApi(`/messages?${queryName}=${encodeURIComponent(target.id)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: String(message).slice(0, 4000), attachments })
  }, env);
}

function parseMaxTarget(value) {
  const raw = String(value || "");
  const match = raw.match(/^(chat|user):(.+)$/);
  if (match) return { type: match[1], id: match[2] };
  return { type: "chat", id: raw };
}

async function uploadMaxImage(bytes, env) {
  const mime = detectImageMime(bytes);
  if (!["image/png", "image/jpeg", "image/gif"].includes(mime)) {
    throw new Error(`MAX не принимает изображение формата ${mime}`);
  }

  const init = await maxApi("/uploads?type=image", { method: "POST" }, env);
  const uploadUrl = init?.url;
  if (!uploadUrl) throw new Error("MAX не вернул URL загрузки изображения");

  const form = new FormData();
  form.append("data", new Blob([Buffer.from(bytes)], { type: mime }), "pomoshchnik-post.jpg");
  const uploaded = await fetchWithRetry(uploadUrl, {
    method: "POST",
    headers: { authorization: env.MAX_BOT_TOKEN },
    body: form
  }, { attempts: 1, timeoutMs: 60000 });
  const result = await uploaded.json().catch(() => ({}));
  if (!uploaded.ok) throw new Error(`MAX загрузка изображения ${uploaded.status}: ${formatUploadError(result)}`);
  const token = findUploadedMediaToken(result);
  if (!token) throw new Error("MAX не вернул токен загруженного изображения");
  return { type: "image", payload: { token } };
}

function findUploadedMediaToken(result) {
  if (!result || typeof result !== "object") return "";
  if (typeof result.token === "string" && result.token) return result.token;

  // MAX returns image uploads as { photos: { photoIds: { token } } }.
  // Keep the fallback recursive so the parser also handles a dynamic photo id.
  for (const [key, value] of Object.entries(result)) {
    if (key === "token" && typeof value === "string" && value) return value;
    if (value && typeof value === "object") {
      const nested = findUploadedMediaToken(value);
      if (nested) return nested;
    }
  }
  return "";
}

async function maxApi(path, init = {}, env) {
  if (!env.MAX_BOT_TOKEN) throw new Error("MAX_BOT_TOKEN не задан");
  const base = (env.MAX_API_BASE_URL || "https://platform-api2.max.ru").replace(/\/$/, "");
  const headers = new Headers(init.headers || {});
  headers.set("authorization", env.MAX_BOT_TOKEN);
  if (init.body && !headers.has("content-type") && !(init.body instanceof FormData)) {
    headers.set("content-type", "application/json");
  }
  const response = await fetchWithRetry(`${base}${path}`, { ...init, headers }, { attempts: 3, timeoutMs: 30000 });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.message || data.error || data.error_description || `HTTP ${response.status}`;
    throw new Error(`MAX API: ${detail}`);
  }
  return data;
}

async function fetchWithRetry(url, init = {}, options = {}) {
  const attempts = Math.max(1, Number(options.attempts) || 1);
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || 30000);
  const bodyFactory = init.bodyFactory;
  const requestInit = { ...init };
  delete requestInit.bodyFactory;
  const targets = retryTargets(url);
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const target = targets[attempt % targets.length];
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(target, {
        ...requestInit,
        body: bodyFactory ? bodyFactory() : requestInit.body,
        signal: controller.signal
      });
      if (!isRetryableStatus(response.status) || attempt === attempts - 1) return response;
      lastError = new Error(`HTTP ${response.status}`);
      if (options.logRetries !== false) console.warn("network request retry", { host: new URL(target).hostname, status: response.status });
    } catch (error) {
      lastError = error;
      if (!isRetryableError(error) || attempt === attempts - 1) throw error;
      if (options.logRetries !== false) console.warn("network request retry", {
        host: new URL(target).hostname,
        code: error?.code || error?.cause?.code || error?.name
      });
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(1200, 250 * (attempt + 1))));
  }
  throw lastError || new Error("сетевой запрос не выполнен");
}

function retryTargets(value) {
  return [new URL(value).toString()];
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function isRetryableError(error) {
  const code = error?.code || error?.cause?.code;
  return error?.name === "AbortError" || error?.name === "TypeError" || String(code || "").startsWith("UND_ERR");
}

function userFacingError(error) {
  const code = error?.code || error?.cause?.code;
  if (error?.name === "AbortError" || code === "UND_ERR_CONNECT_TIMEOUT" || code === "UND_ERR_HEADERS_TIMEOUT") {
    return "внешний сервис не ответил вовремя. Попробуйте ещё раз через минуту";
  }
  return error?.message || "ошибка сервиса";
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

function normalizeHashtags(value, env = {}) {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  const hashtags = [];
  const required = String(env.REQUIRED_HASHTAGS || "")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
  const mandatory = required.length ? required : DEFAULT_REQUIRED_HASHTAGS;
  for (const item of source) {
    const tag = String(item || "").trim().replace(/^#+/, "");
    if (!tag) continue;
    const normalized = `#${tag.replace(/[^\p{L}\p{N}_-]/gu, "")}`;
    if (normalized.length > 1 && !hashtags.includes(normalized)) hashtags.push(normalized);
    if (hashtags.length >= 8) break;
  }
  for (const item of mandatory) {
    const tag = String(item).trim().replace(/^#+/, "");
    const normalized = `#${tag.replace(/[^\p{L}\p{N}_-]/gu, "")}`;
    if (normalized.length > 1 && !hashtags.includes(normalized)) hashtags.push(normalized);
  }
  return hashtags;
}

function detectImageMime(bytes) {
  if (bytes?.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes?.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes?.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) return "image/gif";
  if (bytes?.length >= 12
    && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46
    && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  return "image/png";
}

function formatUploadError(upload) {
  const error = upload?.error;
  if (typeof error === "string" && error) return error;
  if (error?.message) return String(error.message);
  if (error?.error_msg) return String(error.error_msg);
  if (upload?._raw) return "сервер вернул не-JSON ответ";
  return "неизвестный ответ сервера загрузки";
}
