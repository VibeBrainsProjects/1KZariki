# ARCHITECTURE · Техническая архитектура

Как устроено приложение **1KZARIKI**: технологии, структура кода, модель данных, движок подсчёта, хранилище, синхронизация, деплой и тех-долг. Поведение с точки зрения пользователя — в [SPEC.md](SPEC.md).

---

## 1. Технологии и решение «один файл»

Всё приложение — единственный `index.html`:

- **React 18 + ReactDOM** (UMD-сборки с cdnjs).
- **Babel Standalone** — JSX компилируется в браузере (`<script type="text/babel">`).
- **Ванильный CSS** с дизайн-токенами в `:root`, без UI-фреймворка.
- **Google Fonts**: Unbounded, Manrope, JetBrains Mono, Caveat.

Почему так: v1 должен открываться двойным кликом и класться на любой статический хостинг без тулчейна. Цена — Babel компилирует JSX на старте (доли секунды) и не годится для прод-нагрузки; план переезда на Vite — §9.

## 2. Структура кода

Внутри `<script type="text/babel">` модули идут сверху вниз:

1. **store** — обёртка над `localStorage` с откатом в память; `loadDB` / `saveDB`; `uid()`.
2. **Правила** — `DEFAULT_RULES`, `PRESETS`, `QUICK` (быстрые комбо по шкале), `PIT_LINES`.
3. **Движок** — `totalsFor(game)`, `leaderId`, `winnerId`.
4. **Статистика** — `aggregate(db)`.
5. **UI-хелперы** — `DieLogo`, `Sheet`.
6. **Модалки** — `NumberModal`, `KeyboardModal`, `ConfirmModal`.
7. **Экраны** — `Home`, `NewGame` (`RuleRow`), `GameBoard`, `RulesPage`, `Stats`, `SyncPanel`.
8. **Синк** — `SyncCfg`, `gistPush`, `gistPull`.
9. **Оболочка** — `App` (роутинг состоянием, persistence, тосты) и монтирование.

Роутинга-библиотеки нет: текущий экран — это `view = { name, id? }` в состоянии `App`.

## 3. Модель данных

```ts
type DB = { games: Game[] };

type Game = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  players: Player[];
  rules: Rules;
  turns: Turn[];
};

type Player = { id: string; name: string };

type Turn = {
  id: string;
  scores: { [playerId: string]: number | null }; // null = пустая клетка
};

type Rules = {
  target: number;                       // 1000
  barrelAt: number;                     // 850 | 880 | 1000 (1000 = без бочки)
  scale: 'classic' | 'fast';
  exact: boolean;
  pitLines: number[];                   // активные ямы (выходы): [300,700] | [300] | [700] | []
  samosval: 0 | -50 | -100;             // штраф за каждый болт (кон в ноль)
  dump555: 'off' | 1 | 2 | 3 | 'always';// счёт ровно 555 → сброс в ноль; сколько раз срабатывает
  bolt3: 0 | -50 | -100;                // штраф за 3 болта подряд
  overtake: 0 | -50 | -100;             // откат обогнанного
  entry: 0 | 100 | 120;                 // порог входа
  entryMode: 'once' | 'each';
  confirm: boolean;                     // зарезервировано (подтверждающий бросок)
};
```

Константа `PIT_LINES = [300, 600]` — дефолт для совместимости со старым флагом `pits`; актуальные позиции берутся из `rules.pitLines`.

## 4. Хранилище (persistence)

- Ключ: `1kzariki:db:v1`. Значение — `JSON.stringify(DB)`.
- `store` пробует `localStorage`; если он недоступен или кидает исключение (приватный режим, песочница) — молча переходит на объект в памяти `mem`. Приложение не падает в любом случае.
- `App` сохраняет весь `DB` в `useEffect` на каждое изменение состояния.
- Конфиг синка — отдельный ключ `1kzariki:sync` (`{ token, gistId }`).

## 5. Движок подсчёта

Сердце приложения — `totalsFor(game)`. Это **хронологический симулятор**: он проигрывает все коны по порядку (строки сверху вниз, внутри строки — игроки слева направо) и для каждого игрока возвращает агрегаты и статусы. Функция чистая и идемпотентная — пересчитывается на каждый рендер от исходной таблицы, поэтому правки и удаления конов всегда дают согласованный результат.

### 5.1. Результат на игрока

```ts
type PlayerState = {
  total: number;       // итог с учётом штрафов
  busts: number;       // число болтов (конов в ноль)
  dumps: number;       // число сработавших самосвалов (счёт = 555)
  dumpTurns: number[]; // индексы конов, на которых сработал самосвал
  best: number;        // лучший кон
  penalties: number;   // суммарный вычет (положительное число)
  opened: boolean;     // зашёл ли в игру
  everBarrel: boolean; // был ли когда-либо на бочке
  // финальные флаги:
  onBarrel: boolean;   // barrelAt <= total < target
  remaining: number;   // target - total
  won: boolean;        // exact ? total===target : total>=target
  over: boolean;       // exact && total>target
  pit: number | null;  // ближайшая яма, в зоне которой стоит игрок
  needEntry: number;   // порог, если ещё не зашёл (иначе 0)
};
```

### 5.2. Алгоритм

```text
threshold = rules.entry || 0
reentry   = threshold > 0 && rules.entryMode === 'each'

для каждого turn по порядку:
  для каждого player (порядок колонок):
    v = turn.scores[pid]; если v == null — пропустить

    ── РЕЖИМ "КАЖДЫЙ РАЗ" (reentry) ──
    если reentry:
      если v >= threshold:
        opened = true; total += v; best = max(best, v)
      иначе:
        если v === 0: busts++
        total = 0; opened = false; boltRun = 0     // обнуление и выход из игры

    ── РЕЖИМ "1 ЗАХОД" (или порог выключен) ──
    иначе:
      если не opened:
        если threshold > 0 и v < threshold: пропустить   // ещё не зашёл, ничего не пишем
        opened = true
      total += v; best = max(best, v)
      если v === 0:
        busts++; boltRun++
        если samosval: total += samosval; penalties += |samosval|
        если bolt3 и boltRun >= 3: total += bolt3; penalties += |bolt3|; boltRun = 0
      иначе:
        boltRun = 0

    ── САМОСВАЛ (счёт ровно 555) ──
    lim = dump555 ('off' | 1 | 2 | 3 | 'always')
    если total === 555 и (lim==='always' или (число и dumps < lim)):
      total = 0; dumps++; dumpTurns += ti     // сброс; за лимитом 555 остаётся как есть

    ── после хода игрока ──
    если barrelAt < target и barrelAt <= total < target: everBarrel = true

    если overtake:
      для каждого соперника q (opened, q.total > 0):
        если q.total === total:           // догнал точно в счёт
          q.total += overtake; q.penalties += |overtake|

финал для каждого игрока:
  onBarrel  = barrelAt < target && barrelAt <= total < target
  remaining = target - total
  won       = exact ? total === target : total >= target
  over      = exact && total > target
  pit       = pitLines.length ? первая l из pitLines, где (l-100) <= total < l : null
  needEntry = (threshold > 0 && !opened) ? threshold : 0
```

### 5.3. Важные нюансы

- **До захода ничего не пишется и не считается болтом.** В режиме «1 заход» суб-пороговые коны до открытия просто пропускаются (`continue`), поэтому ноль до захода — не самосвал.
- **«1 заход» необратим.** После открытия `opened` не сбрасывается, даже если штрафы увели `total` в минус.
- **«Каждый раз» жёсткий.** Любой кон `< threshold` (включая ноль) сбрасывает `total` в 0 и снимает `opened`. Накопить можно только серией бросков `>= threshold`.
- **Обгон — только точное равенство.** Обгоняющий остаётся, обогнанный уходит в минус на `overtake`. Считается прямо в хронологическом проходе.
- **Штрафы уже внутри `total`.** Поле `penalties` — только для отображения строки «штраф −N».

### 5.4. Производные

- `leaderId(game, tot)` — игрок с максимальным `total` (> 0), иначе `null`.
- `winnerId(game, tot)` — первый игрок с `won === true`, иначе `null`.

## 6. Статистика

`aggregate(db)` группирует игроков по нормализованному имени (trim + lowercase) через все партии и считает: `wins`, `games`, `barrels` (по `everBarrel`), `busts`, `best`, `points` (сумма `total`). Возвращает отсортированную по победам таблицу и тоталы (партии / бочки / самосвалы). Победа начисляется игроку, у которого `winnerId` партии.

## 7. Синхронизация (GitHub Gist)

Чистый фронт, без своего бэкенда: весь `DB` лежит одним файлом в приватном gist.

- `SyncCfg` — `{ token, gistId }` в `1kzariki:sync`.
- `gistPush(db)` — `POST /gists` (первый раз) или `PATCH /gists/:id`, файл `1kzariki.json` с `JSON.stringify(db)`; сохраняет `gistId`.
- `gistPull()` — `GET /gists/:id`, парсит `files['1kzariki.json'].content`, возвращает `DB`.
- Экспорт/импорт — `Blob` → скачивание `1kzariki-backup.json` и `FileReader` для загрузки. Это и фундамент под облако, и независимый бэкап.

Токен хранится только локально; в облако данные уходят исключительно по кнопке.

## 8. PWA (офлайн и установка)

Приложение — устанавливаемая PWA. Три части:

- **`manifest.webmanifest`** — `name`/`short_name` «Зарики», `start_url`/`scope` = `./` (относительные, чтобы работать из подпапки на GitHub Pages), `display: standalone`, `orientation: any`, `theme_color`/`background_color` = `#15181C`, иконки 192/512 (`any`) и 512 (`maskable`).
- **`sw.js`** — service worker. Кэш версионируется именем `CACHE` (`1kzariki-vN`). На `install` кладёт app-shell в кэш (локальные файлы + CDN-скрипты React/ReactDOM/Babel — у cdnjs есть CORS). На `activate` чистит старые кэши и берёт клиентов под контроль (`skipWaiting` + `clients.claim`). На `fetch` — cache-first: отдаёт из кэша, иначе сеть + рантайм-докэширование для своего origin и хостов шрифтов/cdnjs; при офлайне на навигацию отдаёт `./index.html`.
- **Иконки** — `icons/` (192, 512, maskable-512, apple-touch-180, favicon-32), сгенерированы из логотипа-зарика.
- **`index.html`** — `<link rel="manifest">`, `theme-color`, apple-метатеги, `apple-touch-icon`, favicon и регистрация SW обычным (не Babel) скриптом по `load`.

Требования к установке: HTTPS (GitHub Pages даёт), манифест с иконками 192/512, зарегистрированный SW с обработчиком `fetch`. Всё выполнено.

> **Релизный момент:** при изменении `index.html` или CDN-версий **поднимай версию `CACHE` в `sw.js`** — иначе пользователи продолжат получать старую оболочку из кэша.

## 9. Сборка и деплой

Сборки нет. Деплой = выложить `index.html` на статический хостинг.

```bash
# локально
python3 -m http.server 8080

# GitHub Pages — отдать index.html из ветки/папки Pages
```

**Деплой.** Сайт — статика в корне, поэтому публикуется прямо из ветки: Settings → Pages → Source: «Deploy from a branch» → `main`, `/ (root)`. Файл `.nojekyll` в корне отключает Jekyll, чтобы `sw.js`/`icons/` отдавались без обработки. Относительные пути (`./…`) обеспечивают работу на project-сайте `https://vibebrainsprojects.github.io/1KZariki/`.

## 10. Миграция на Vite (план)

Когда захочется убрать Babel-in-browser и разбить на модули:

1. `npm create vite@latest 1kzariki -- --template react`.
2. Разнести по файлам: `engine.js` (`totalsFor`, `aggregate`, `leaderId`, `winnerId`), `store.js`, `sync.js`, `rules.js` (константы), `components/*` (модалки и экраны), `App.jsx`.
3. CSS из `<style>` → `index.css` (токены оставить в `:root`).
4. Шрифты и CDN-скрипты → npm-зависимости (`react`, `react-dom`).
5. Движок чистый и без зависимостей от DOM — переносится один-в-один, под него легко завести юнит-тесты (см. §10).

## 11. Тестирование

Движок (`totalsFor`) детерминирован и не зависит от React — идеальный кандидат на юнит-тесты. Минимальный набор кейсов:

- сумма конов и `best`;
- бочка: `onBarrel` и `remaining` на границах `[barrelAt, target)`;
- `exact`: победа на ровно `target`, `over` на превышении;
- заход «1 заход»: суб-пороговые коны до открытия не считаются и не болты; после открытия считается всё;
- «каждый раз»: обнуление на `< threshold`, перезаход на `>= threshold`;
- 3 болта подряд: вычет и обнуление счётчика;
- обгон: откат при точном равенстве.

## 12. Тех-долг / TODO

- [ ] Авто-энфорс «один на бочке — второй слетает».
- [ ] Подтверждающий бросок (`confirm`).
- [ ] Гасить серым коны до захода / сгоревшие при обнулении.
- [ ] Перенос на Vite + юнит-тесты движка.
- [x] PWA (service worker, манифест, офлайн, установка).
