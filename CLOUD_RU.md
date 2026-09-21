# Деплой «Помощника рядом» в Cloud.ru

Сервис переносится в **Cloud.ru Evolution Container Apps**. Он запускается из `Dockerfile`, слушает `0.0.0.0:$PORT` и не требует работы на локальном ПК.

## Что нужно заранее

1. Аккаунт Cloud.ru Evolution с доступом к Container Apps и Artifact Registry.
2. MAX-бот, созданный через «MAX для бизнеса», и его токен.
3. HTTPS-адрес контейнера Cloud.ru. MAX принимает Webhook только на доверенном HTTPS-сертификате и порту 443.
4. SmartAPI-ключ. Секреты добавляются в переменные окружения Cloud.ru и не коммитятся в Git.

## Переменные окружения

```text
OPENAI_API_KEY=...
OPENAI_BASE_URL=https://api.smartapi.shop/v1
TEXT_MODEL=gpt-5.6-luna
MAX_BOT_TOKEN=...
MAX_WEBHOOK_SECRET=случайная-строка-из-букв-цифр-и-дефисов
MAX_API_BASE_URL=https://platform-api2.max.ru
REQUIRED_HASHTAGS="#ВСНП_МОСКВА #Наставничество #Просвещение #Москва"
```

## Вариант через интерфейс Cloud.ru

1. Создайте Docker-реестр в Artifact Registry, например `vsnp-pomosh`. После создания его URI будет `vsnp-pomosh.cr.cloud.ru`.
2. Добавьте в GitHub repository secrets `CLOUD_REGISTRY_HOST` (значение `vsnp-pomosh.cr.cloud.ru`), `CLOUD_REGISTRY_KEY_ID` и `CLOUD_REGISTRY_KEY_SECRET`. Workflow **Publish Cloud.ru image** соберёт образ для `linux/amd64` и опубликует `vsnp-pomosh.cr.cloud.ru/vsnp-pomosh-max:latest`. GHCR-публикация остаётся как резервная.
3. В Cloud.ru откройте Container Apps / Container Services и нажмите **Создать**. В поле URI образа укажите `vsnp-pomosh.cr.cloud.ru/vsnp-pomosh-max:latest`.
4. Укажите порт контейнера `3000`, включите публичный адрес, минимальное число экземпляров `0`, максимальное `1`. Для Webhook приложение должно быть доступно постоянно; если масштабирование до нуля приводит к пропуску событий, установите минимум `1` и проверьте доступный бесплатный лимит.
5. Добавьте переменные из списка выше и создайте ревизию.
6. Откройте выданный Cloud.ru URL и проверьте `GET /health`. Ожидается JSON с `"transport":"max"`.

## Подписка MAX Webhook

После появления HTTPS-адреса выполните один раз, подставив токен и URL:

```bash
curl -X POST "https://platform-api2.max.ru/subscriptions" \
  -H "Authorization: $MAX_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://YOUR-CLOUD-DOMAIN/webhook/max",
    "update_types": ["message_created", "message_callback", "bot_started"],
    "secret": "YOUR-MAX-WEBHOOK-SECRET"
  }'
```

MAX будет отправлять секрет в заголовке `X-Max-Bot-Api-Secret`. Сервис отвечает `200` сразу, а генерация выполняется в фоне.

## Проверка сценария

Откройте MAX-бота, нажмите **Новый пост**, отправьте текст и оригинальное фото двумя сообщениями в любом порядке. Бот сохраняет людей и фон, локально накладывает логотип и фирменные волны, затем возвращает текст и изображение. Кнопки **Помощь** и **Отмена** работают у всех пользователей.

## Важно про бесплатный тариф

У Cloud.ru Evolution есть отдельные ограничения free tier. Перед включением Container Apps проверьте текущий лимит и стоимость в разделе тарификации аккаунта. При нулевом минимальном числе экземпляров первый Webhook после простоя может прийти с задержкой; для MAX лучше держать один экземпляр, если это укладывается в доступный лимит.
