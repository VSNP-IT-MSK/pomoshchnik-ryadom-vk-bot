const JSON_HEADERS = { "content-type": "application/json; charset=utf-8" };

const BRAND_STYLE = `
Фирменная стилистика ВСНП Москва: палитра #B88FFF (лавандовый), #7F74D8 (фиолетовый),
#FFD21F (жёлтый акцент), #29747D и #0C4746 (глубокий бирюзовый), белый.
Графический язык — мягкие текучие линии и волнообразные формы, четыре тонких
конца звезды как знак вдохновения и открытых возможностей. Используй много воздуха,
современную редакционную фотографию, естественный свет, живых людей и атмосферу
поддержки и роста. Оставляй свободную область сверху или слева для заголовка.
Не добавляй читаемый текст, водяные знаки и чужие логотипы.`.trim();

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
      if (request.headers.get("authorization") !== `Bearer ${env.CRON_SECRET}`) {
        return new Response("unauthorized", { status: 401 });
      }
      ctx.waitUntil(generateAndPublish("Полезная привычка для учёбы и наставничества", env));
      return new Response("accepted", { status: 202 });
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
      // VK confirmation requests contain only type and group_id.
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
      ctx.waitUntil(handleMessage(payload, env));
    }

    return new Response("ok", { headers: { "content-type": "text/plain; charset=utf-8" } });
  }
};

async function handleMessage(payload, env) {
  const message = payload.object?.message || payload.object || {};
  const peerId = Number(message.peer_id || message.from_id);
  const fromId = Number(message.from_id || peerId);
  const text = String(message.text || "").trim();
  if (!peerId || !text) return;

  const command = text.replace(/^\s+/, "");
  if (/^(?:\/help|помощь|начать)$/iu.test(command)) {
    await sendMessage(peerId, "Команды:\n/post тема — создать черновик поста и изображения\n/publish тема — создать и опубликовать (только администратору)\n/daily — опубликовать пост дня (только администратору)", env);
    return;
  }

  const postMatch = command.match(/^\/(post|publish)\s+(.{3,300})$/iu);
  if (postMatch) {
    const mode = postMatch[1].toLowerCase();
    const topic = postMatch[2].trim();
    if (!isAdmin(fromId, env)) {
      await sendMessage(peerId, "Команды создания и публикации доступны только администратору группы.", env);
      return;
    }
    await sendMessage(peerId, "Готовлю текст и визуал в фирменном стиле…", env);
    try {
      const result = await generatePost(topic, env);
      if (mode === "publish") {
        const wall = await publishToWall(result, env);
        await sendMessage(peerId, `Опубликовано в группе: https://vk.com/wall${wall.owner_id}_${wall.post_id}`, env);
      } else {
        await sendMessage(peerId, formatPost(result), env, result.attachment);
      }
    } catch (error) {
      console.error(error);
      await sendMessage(peerId, `Не удалось создать пост: ${error.message || "ошибка сервиса"}`, env);
    }
    return;
  }

  if (/^\/daily$/iu.test(command)) {
    if (!isAdmin(fromId, env)) {
      await sendMessage(peerId, "Команда публикации доступна только администратору группы.", env);
      return;
    }
    await sendMessage(peerId, "Готовлю пост дня…", env);
    try {
      const result = await generateAndPublish("Полезная привычка для учёбы и наставничества", env);
      await sendMessage(peerId, `Готово: https://vk.com/wall${result.owner_id}_${result.post_id}`, env);
    } catch (error) {
      console.error(error);
      await sendMessage(peerId, `Не удалось опубликовать пост: ${error.message || "ошибка сервиса"}`, env);
    }
    return;
  }

  await sendMessage(peerId, "Напишите /help, чтобы увидеть команды. Например: /post как поддержать подростка перед экзаменом", env);
}

function isAdmin(userId, env) {
  return String(env.ADMIN_VK_IDS || "").split(",").map((x) => x.trim()).filter(Boolean).includes(String(userId));
}

async function generateAndPublish(topic, env) {
  const result = await generatePost(topic, env);
  return publishToWall(result, env);
}

async function generatePost(topic, env) {
  const draft = await generateCopy(topic, env);
  const imageBytes = await generateImage(draft.image_prompt, env);
  const attachment = await uploadWallPhoto(imageBytes, env);
  return { ...draft, attachment };
}

async function generateCopy(topic, env) {
  const communityName = env.COMMUNITY_NAME || "Помощник рядом";
  const prompt = `Создай пост для сообщества «${communityName}» на тему: ${topic}\n\n` +
    `Аудитория: подростки, молодые люди, наставники, родители и специалисты помогающих профессий в Москве.\n` +
    `Сохрани редакционную логику: короткий цепляющий заголовок, 2–4 абзаца с одной практической мыслью, ` +
    `бережный тон без назидательности, в конце конкретный вопрос или мягкий призыв к диалогу. ` +
    `Пиши по-русски, без канцелярита и рекламных обещаний.\n\n` +
    `Ориентир по объёму текста: 900–1300 знаков. Для анонса с условиями допустимо до 1500 знаков. ` +
    `Структура: короткий заголовок, кому это полезно, суть/условия, конкретный следующий шаг, ` +
    `снятие одного барьера и финальный CTA. Верни только JSON с полями: title, text, image_prompt, hashtags. ` +
    `image_prompt должен быть на английском и описывать одну фотореалистичную сцену. ` +
    `hashtags — массив из 2–4 хэштегов.`;

  const data = await openAI("/chat/completions", {
    model: env.TEXT_MODEL || "gpt-5.6-luna",
    temperature: 0.7,
    messages: [
      { role: "system", content: `Ты редактор сообщества «${communityName}». Пиши ясно, тепло и конкретно. Не выдумывай факты, даты и цифры. Тон официальный, доброжелательный и мотивирующий, без канцелярита.` },
      { role: "user", content: prompt }
    ]
  }, env);
  const raw = data.choices?.[0]?.message?.content || "{}";
  const parsed = parseJson(raw);
  if (!parsed.title || !parsed.text || !parsed.image_prompt) throw new Error("модель вернула неполный пост");
  return {
    title: String(parsed.title).trim(),
    text: String(parsed.text).trim(),
    image_prompt: `${parsed.image_prompt}. ${BRAND_STYLE}`,
    hashtags: Array.isArray(parsed.hashtags) ? parsed.hashtags.map(String).slice(0, 6) : ["#ПомощникРядом", "#Москва"]
  };
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
  const base = (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error?.message || `AI API ${response.status}`);
  return data;
}

async function uploadWallPhoto(bytes, env) {
  const server = await vk("photos.getWallUploadServer", { group_id: env.VK_GROUP_ID }, env);
  const form = new FormData();
  form.append("photo", new Blob([bytes], { type: "image/png" }), "vsnp-post.png");
  const uploadResponse = await fetch(server.upload_url, { method: "POST", body: form });
  const upload = await uploadResponse.json();
  if (!upload.photo) throw new Error("VK не принял изображение");
  const saved = await vk("photos.saveWallPhoto", { group_id: env.VK_GROUP_ID, photo: upload.photo, server: upload.server, hash: upload.hash }, env);
  const photo = saved[0];
  if (!photo) throw new Error("VK не сохранил изображение");
  return `photo${photo.owner_id}_${photo.id}`;
}

async function publishToWall(post, env) {
  const result = await vk("wall.post", {
    owner_id: `-${env.VK_GROUP_ID}`,
    from_group: 1,
    message: formatPost(post),
    attachments: post.attachment
  }, env);
  return { owner_id: `-${env.VK_GROUP_ID}`, post_id: result.post_id };
}

async function sendMessage(peerId, message, env, attachment = "") {
  return vk("messages.send", { peer_id: peerId, random_id: Math.floor(Math.random() * 2_000_000_000), message, attachment }, env);
}

async function vk(method, params, env) {
  if (!env.VK_GROUP_TOKEN) throw new Error("VK_GROUP_TOKEN не задан");
  const body = new URLSearchParams({ ...params, access_token: env.VK_GROUP_TOKEN, v: env.VK_API_VERSION || "5.199" });
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

function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
