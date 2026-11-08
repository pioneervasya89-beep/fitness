#!/bin/bash
# Подключает Mini App к боту: кнопка меню «Тренировка» открывает приложение.
# Запуск: bash setup_bot.sh https://адрес-приложения/
set -e
URL="${1:?Укажи адрес приложения: bash setup_bot.sh https://...}"
read -rsp "Вставь токен бота от @BotFather и нажми Enter: " TOKEN; echo
API="https://api.telegram.org/bot$TOKEN"

ME=$(curl -s "$API/getMe")
echo "$ME" | grep -q '"ok":true' || { echo "Токен не подошёл: $ME"; exit 1; }
echo "Бот найден: $(echo "$ME" | sed -E 's/.*"username":"([^"]+)".*/@\1/')"

curl -s -X POST "$API/setChatMenuButton" -H 'Content-Type: application/json' \
  -d "{\"menu_button\":{\"type\":\"web_app\",\"text\":\"Тренировка\",\"web_app\":{\"url\":\"$URL\"}}}" \
  | grep -q '"ok":true' && echo "Кнопка меню «Тренировка» → $URL"

curl -s -X POST "$API/setMyDescription" -H 'Content-Type: application/json' \
  -d '{"description":"Дневник тренировок с автоматической прогрессией. Нажми «Тренировка» внизу."}' >/dev/null

echo "Готово. Открой бота в Telegram и нажми кнопку «Тренировка» слева от поля ввода."
