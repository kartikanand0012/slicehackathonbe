# SliceSplit Frontend — Detailed Guide

> Hand-verified rewrite of the GitNexus-generated wiki, grounded in the actual source on `feature/ai-chat-notifications-contacts` (HEAD `f565308`). Every prop, state name, function signature, and route below has been read out of `src/` directly — no fabricated services, no invented APIs.
>
> Companion artifacts:
> - Knowledge graph (interactive, queryable): `gitnexus serve --port 4747` → https://gitnexus.vercel.app, or `gitnexus context <symbol>` on the CLI.
> - GitNexus-generated wiki (raw, partially hallucinated): `.gitnexus/wiki/index.html` — kept for reference, **not authoritative**.
> - Older architecture docs: [HLD.md](./HLD.md) · [LLD.md](./LLD.md) · [COMPONENTS.md](./COMPONENTS.md) · [INTEGRATIONS.md](./INTEGRATIONS.md). Those are accurate up to `phase1-cleanup` (before AI Chat / contacts / notifications). This doc supersedes COMPONENTS.md.

---

## How to read this

The frontend is a React 18 SPA built with Vite. It ships two major surfaces — the **lender** (`/splitbill`) and the **borrower** (`/inbox`) — plus a stack of authentication and dashboard pages. Both major surfaces talk to the same backend through `src/api/split.js`, which is the single fetch wrapper for every `/api/*` route.

Sections below mirror the 26 modules GitNexus carved out of the codebase (you'll see the same names in the knowledge graph), grouped into seven concerns:

| Concern | Modules |
|---|---|
| App shell | `main`, `App`, `query-client`, `ScrollToTop`, `PageNotFound` |
| Auth + identity | `AuthContext`, `AuthLayout`, `app-params`, `base44Client`, `UserNotRegisteredError`, `Login`, `Register`, `ForgotPassword`, `ResetPassword`, `PinLogin`, `Splash` |
| Slice nav primitives | `BottomNav`, `Numpad`, `NumpadKey`, `GoogleIcon` |
| UI primitives (shadcn) | `button`, `input`, `label`, `input-otp`, `toast`, `toaster`, `use-toast` |
| Dashboard stubs | `Home`, `Activity`, `Banking`, `Credit`, `Explore` |
| **Bill-split lender surface** | `SplitBill` (3 785 LOC — the centrepiece) |
| **Bill-split borrower surface** | `Inbox` (1 289 LOC) |
| Cross-cutting libs | `split` (API client), `voice`, `contacts`, `utils`, `use-mobile` |

---

## Where to change what

GitNexus-style navigation table. If you're modifying a concern, this is the first stop.

| If you want to… | Open |
|---|---|
| Add or remove a top-level route | `src/App.jsx` (lines 44–55 — the `<Routes>` block) |
| Add or rename an API endpoint | `src/api/split.js` (single source of truth for fetch URLs) + the matching Express handler in `server/index.js` |
| Change the bottom nav order, label, or destination | `src/components/slice/BottomNav.jsx:84` (`navItems` array) |
| Add a new intent the AI chat can run | `server/claude.js` (extend the `intent` enum + system prompt) + `SplitBill.jsx` `ACTION` map in `AIChatSheet` + the `onExecute` dispatcher in `<SplitBill>` |
| Add a sub-component to the lender flow | `src/pages/SplitBill.jsx` — pick a section break in the comment banners ("`/* === ... === */`") |
| Add a sub-component to the borrower flow | `src/pages/Inbox.jsx` — same banner-style section breaks |
| Edit auth flow (login / register / OTP) | `src/pages/{Login,Register,ForgotPassword,ResetPassword}.jsx` — each is independent; all wrap in `<AuthLayout>` |
| Change PIN entry visuals | `src/pages/PinLogin.jsx` + `src/components/slice/Numpad.jsx` + `NumpadKey.jsx` |
| Add a contact field (e.g. email) | `src/lib/contacts.js` for parsers/helpers, `src/pages/SplitBill.jsx` `ContactsSheet` for UI, `src/api/split.js` `addContact`/`updateContact` for the wire shape |
| Wire @mention into another input | `src/lib/contacts.js` exports `getMentionTrigger` + `filterContactsForMention` + `applyMentionSelection`; reuse the `<MentionSuggestions>` component from `SplitBill.jsx` |
| Replace Web Speech with a different STT | `src/lib/voice.js` — `createRecognizer` is the one factory; every caller goes through it |
| Change ledger poll rate | `src/pages/SplitBill.jsx` bootstrap `useEffect` (1 500 ms) and `Inbox.jsx` bootstrap `useEffect` (1 500 ms). `GroupChat` polls messages at 2 000 ms. |
| Bump notification mark-read storage | `localStorage` key `ss.notif.readAt` in `SplitBill.jsx` |
| Bump contacts permission gate | `localStorage` key `ss.contacts.perm` in `SplitBill.jsx` `<ContactsSheet>` |

---

## Repository layout (frontend)

```
src/
├── main.jsx                 ─ React root mount
├── App.jsx                  ─ Auth gate + route table (10 routes)
├── index.css                ─ Tailwind base + CSS vars (--background, --foreground, ...)
│
├── api/
│   ├── base44Client.js      ─ Base44 SDK instance for auth flows
│   └── split.js             ─ 26 fetch wrappers for /api/*  (single source of truth)
│
├── lib/
│   ├── AuthContext.jsx      ─ AuthProvider + useAuth hook
│   ├── app-params.js        ─ env / URL param / localStorage chain
│   ├── query-client.js      ─ TanStack Query instance (refetchOnWindowFocus: false)
│   ├── voice.js             ─ createRecognizer + voiceSupported
│   ├── contacts.js          ─ @mention parser + WhatsApp/SMS deep-links
│   ├── utils.js             ─ cn() and isIframe
│   └── PageNotFound.jsx     ─ 404 view (queries base44.auth.me for admin note)
│
├── hooks/
│   └── use-mobile.jsx       ─ useIsMobile() — matchMedia at 768px
│
├── components/
│   ├── AuthLayout.jsx       ─ centred card chrome for Login/Register/Forgot/Reset
│   ├── GoogleIcon.jsx       ─ 4-colour SVG
│   ├── ScrollToTop.jsx      ─ resets scroll on route change (skips POP / handles hash)
│   ├── UserNotRegisteredError.jsx ─ 403 'auth_required' fallback
│   ├── slice/
│   │   ├── BottomNav.jsx    ─ 6-tab black bar
│   │   ├── Numpad.jsx       ─ 4×3 grid wrapper
│   │   └── NumpadKey.jsx    ─ single key (number / dot / backspace / empty)
│   └── ui/
│       ├── button.jsx       ─ shadcn Button + buttonVariants
│       ├── input.jsx
│       ├── label.jsx
│       ├── input-otp.jsx
│       ├── toast.jsx        ─ Radix toast primitives
│       ├── toaster.jsx      ─ Toaster outlet rendered in App
│       └── use-toast.jsx    ─ reducer-driven toast() helper
│
└── pages/
    ├── Splash.jsx           ─ 2.5 s splash → /pin
    ├── PinLogin.jsx         ─ 4-digit PIN → /home
    ├── Home.jsx             ─ amount + numpad
    ├── Banking.jsx          ─ stub
    ├── Credit.jsx           ─ stub
    ├── Explore.jsx          ─ stub
    ├── Activity.jsx         ─ static txn list
    ├── Login.jsx            ─ email / password / Google
    ├── Register.jsx         ─ email → OTP → done
    ├── ForgotPassword.jsx
    ├── ResetPassword.jsx
    ├── SplitBill.jsx        ─ ⭐ lender surface (3 785 LOC)
    └── Inbox.jsx            ─ ⭐ borrower surface (1 289 LOC)
```

Counts you'll see in the knowledge graph: **49 files indexed, 654 symbols, 1 000 edges, 19 clusters, 20 execution flows** (frontend-only scope, `.gitnexusignore` excludes `server/`, `docs/`, `data/`, `node_modules/`, `dist/`, `base44/`, `demo/`).

---

## 1. App shell

### 1.1 `src/main.jsx` (8 lines)

The only thing this file does: mount `<App />` into `#root`. There is no `<StrictMode>` wrapper (it was removed earlier to avoid double-firing certain effects under React 18 strict mode).

```jsx
ReactDOM.createRoot(document.getElementById('root')).render(<App />)
```

### 1.2 `src/App.jsx` (74 lines)

The provider stack + route table + auth gate.

```
<AuthProvider>                          ── from lib/AuthContext.jsx
  <QueryClientProvider>                 ── from lib/query-client.js
    <Router>                            ── react-router v6 BrowserRouter
      <ScrollToTop />
      <AuthenticatedApp />              ── auth-gated route Switch
    </Router>
    <Toaster />                         ── shadcn toast outlet
  </QueryClientProvider>
</AuthProvider>
```

`<AuthenticatedApp>` reads `isLoadingAuth`, `isLoadingPublicSettings`, `authError`, `navigateToLogin` from `useAuth()`. Three branches before rendering routes:

1. **Loading** — either flag true → render a centred spinner (Tailwind animate-spin).
2. **`authError.type === 'user_not_registered'`** → render `<UserNotRegisteredError />`.
3. **`authError.type === 'auth_required'`** → call `navigateToLogin()` and return `null` (Base44 SDK does the redirect).

If none of those match, the route table renders:

| Path | Component | Notes |
|---|---|---|
| `/` | `<Splash />` | 2.5 s splash, then redirects to `/pin` |
| `/pin` | `<PinLogin />` | 4-digit PIN, demo-grade (no real auth) |
| `/home` | `<Home />` | amount + numpad placeholder |
| `/banking` | `<Banking />` | stub for future scope |
| `/credit` | `<Credit />` | stub |
| `/explore` | `<Explore />` | stub |
| `/activity` | `<Activity />` | static transaction list |
| `/splitbill` | `<SplitBill />` | **lender surface** — see §6 |
| `/inbox` | `<Inbox />` | **borrower surface**, reads `?as=<name>` — see §7 |
| `*` | `<PageNotFound />` | 404 with admin-only hint |

### 1.3 `src/lib/query-client.js` (10 lines)

```js
new QueryClient({
  defaultOptions: { queries: { refetchOnWindowFocus: false, retry: 1 } },
})
```

Note: most data fetching in the app is **not** routed through TanStack Query. The bill-split flow uses raw `fetch` (`splitApi`) + `setInterval` polling. Query Client is mainly exercised by `<PageNotFound>`, which calls `base44.auth.me()` via `useQuery`.

### 1.4 `src/components/ScrollToTop.jsx` (33 lines)

Listens to `useLocation()` + `useNavigationType()`. On route change:

- Skip if `navigationType === "POP"` (browser back/forward preserves scroll).
- If there's a `#hash`, decode, `scrollIntoView({behavior: "smooth"})` on the matching element, debounced via 50 ms `setTimeout`.
- Otherwise `window.scrollTo({top: 0, behavior: "instant"})`.

Returns `null` (no DOM).

### 1.5 `src/lib/PageNotFound.jsx` (74 lines)

Default-exported. Reads `useLocation()` for the path. Calls `base44.auth.me()` via `useQuery({queryKey: ['user']})` to fetch the current user.

Renders a centred 404 with "Page Not Found" + the offending path. If the queried user has `role === 'admin'`, also renders an **Admin Note** explaining "the AI hasn't implemented this page yet" — relic of the Base44 dev environment.

---

## 2. Auth + identity

### 2.1 `src/lib/app-params.js` (54 lines)

Pure config resolver. Exports the singleton `appParams` object.

`getAppParamValue(name, { defaultValue, removeFromUrl })` resolution order:

1. URL search param (`?app_id=...&access_token=...`). On read, optionally erases it from the URL via `history.replaceState`.
2. Vite env var (`import.meta.env.VITE_BASE44_APP_ID`, etc.) if `defaultValue` supplied.
3. `localStorage` under key `base44_<snake_case_name>`.
4. `null`.

When `?clear_access_token=true` is present, `localStorage.base44_access_token` is purged before any other lookup.

Final `appParams` shape:

```ts
{
  appId: string | null,
  token: string | null,          // erased from URL on first read
  fromUrl: string,               // defaults to window.location.href
  functionsVersion: string | null,
  appBaseUrl: string | null,
}
```

### 2.2 `src/api/base44Client.js` (14 lines)

A single SDK instance from `@base44/sdk`:

```js
export const base44 = createClient({
  appId, token, functionsVersion,
  serverUrl: '',
  requiresAuth: false,
  appBaseUrl,
})
```

`requiresAuth: false` lets the app boot anonymously and decide what to do based on the `appPublicSettings` returned by `/api/apps/public/.../public-settings/by-id/{appId}`.

### 2.3 `src/lib/AuthContext.jsx` (160 lines)

Default-exports `<AuthProvider>` and `useAuth()`.

**State held in provider:**

| Field | Initial | Set by |
|---|---|---|
| `user` | `null` | `checkUserAuth` on success |
| `isAuthenticated` | `false` | `checkUserAuth` |
| `isLoadingAuth` | `true` | flips false in `checkUserAuth` / errors |
| `isLoadingPublicSettings` | `true` | flips false in `checkAppState` |
| `authError` | `null` | `{type, message}`; types: `auth_required` · `user_not_registered` · `unknown` · raw 403 reason string |
| `authChecked` | `false` | flips true after either auth path resolves |
| `appPublicSettings` | `null` | `{id, public_settings}` from `/api/apps/public/...` |

**Methods exposed via context:**

- `checkAppState()` — `useEffect` on mount fires this exactly once. It hits `/api/apps/public/prod/public-settings/by-id/{appId}` via an ad-hoc `createAxiosClient` (note: separate from the main Base44 SDK instance). On 403, it inspects `error.data.extra_data.reason` and maps to `authError`.
- `checkUserAuth()` — calls `base44.auth.me()`. On 401 / 403 sets `authError = { type: 'auth_required' }`.
- `logout(shouldRedirect = true)` — clears local user state; delegates to `base44.auth.logout(...)` which handles token cleanup + redirect.
- `navigateToLogin()` — `base44.auth.redirectToLogin(window.location.href)`.

`useAuth()` throws "must be used within an AuthProvider" if called outside.

### 2.4 `src/components/AuthLayout.jsx` (23 lines)

Pure chrome for auth forms. Props (none required):

| Prop | Shape | Renders |
|---|---|---|
| `icon` | React component | rendered inside a 14×14 rounded-2xl `bg-primary` tile, with `className="w-7 h-7 text-primary-foreground"` |
| `title` | string | `<h1 class="text-3xl font-bold">` |
| `subtitle` | string \| undefined | `<p class="text-muted-foreground mt-2">` |
| `footer` | React node \| undefined | rendered below the card as muted text |
| `children` | form contents | inside `<div class="bg-card rounded-2xl shadow-sm border p-8">` |

### 2.5 `src/components/UserNotRegisteredError.jsx` (31 lines)

Full-screen error page. No props. Shown when `authError.type === 'user_not_registered'`. Static copy:

> "You are not registered to use this application. Please contact the app administrator to request access."

Includes a bulleted hint with three recovery suggestions.

### 2.6 Auth pages

All four wrap `<AuthLayout>`. Each is independent (no shared state) and uses the Base44 SDK directly.

| Page | LOC | Key state | API calls |
|---|---|---|---|
| `Login.jsx` | 125 | `email`, `password`, `error`, `loading` | `base44.auth.loginViaEmailPassword` |
| `Register.jsx` | 228 | adds `confirmPassword`, `showOtp`, `otpCode` (6-slot `<InputOTP>`) | `base44.auth.register` → `base44.auth.verifyOtp`; `base44.auth.resendOtp` on retry |
| `ForgotPassword.jsx` | 76 | `email`, `loading`, `sent` | `base44.auth.resetPasswordRequest`. Always shows "Check your email" regardless of result (anti-enumeration). |
| `ResetPassword.jsx` | 114 | `newPassword`, `confirmPassword`, `error`, `loading` | reads `?resetToken=`; calls `base44.auth.resetPassword` |

### 2.7 `src/pages/PinLogin.jsx` (85 lines)

Demo PIN entry, **not real auth** — just navigates `/home` on 4 digits.

**State**: `pin: string`.
**Effect**: when `pin.length === 4` → `setTimeout(() => navigate('/home'), 200)`.
**Renders**: greeting + (fake) phone, 4 PIN dots (filled circles with framer-motion scale), Numpad, biometric placeholder button, `<BottomNav />`.

### 2.8 `src/pages/Splash.jsx` (42 lines)

`useEffect`: `setTimeout(() => navigate('/pin'), 2500)`.
Renders the slice logo gradient. No interactivity.

---

## 3. Slice nav primitives

### 3.1 `src/components/slice/BottomNav.jsx` (119 lines)

Default export. **No props.** Reads `useNavigate()` + `useLocation()`.

Local `navItems` constant (line 84) — order = visual order left to right:

| Icon | Label | Path |
|---|---|---|
| `BankIcon` | Banking | `/banking` |
| `ExploreIcon` | Explore | `/explore` |
| `ScanPayIcon` | Pay | `/home` |
| `CreditIcon` | Credit | `/credit` |
| `HistoryIcon` | Activity | `/activity` |
| `SplitBillIcon` | SplitBill | `/splitbill` |

All six icons are inline custom SVGs (defined at the top of the file) — they take a single `active: boolean` prop and toggle between `"white"` and `"rgba(255,255,255,0.4)"`. Lucide is not used here.

On render: `motion.button` per item with `whileTap={{ scale: 0.9 }}`. Active state = path match → white dot below icon + bright fill. Background is hardcoded `#000`.

### 3.2 `src/components/slice/Numpad.jsx` (18 lines)

```jsx
<Numpad onPress={handler} variant="pin" showDot={false} />
```

| Prop | Default | What it does |
|---|---|---|
| `onPress(value)` | required | called with `"0"`–`"9"`, `"."`, or `"backspace"` |
| `variant` | `"pin"` | passed through to `<NumpadKey>` (affects sub-labels visibility) |
| `showDot` | `false` | swap the bottom-left key from spacer to a `.` key |

Layout: CSS `grid grid-cols-3 gap-2`. Rows are `[1,2,3] [4,5,6] [7,8,9] [dot|empty, 0, backspace]`.

### 3.3 `src/components/slice/NumpadKey.jsx` (67 lines)

The leaf. Four render branches selected by `value`:

| `value` | Renders | Click payload |
|---|---|---|
| `"backspace"` | inline X-in-bracket SVG (currentColor) | `onPress("backspace")` |
| `"empty"` | invisible 14-tall spacer | nothing |
| `"dot"` | a `.` label | `onPress(".")` |
| number `"0"`–`"9"` | digit + optional sub-label (ABC, DEF, …) if `variant === "pin"` | `onPress(value)` |

The sub-label table (`subLabels`) is hardcoded at the top of the file — classic dial-pad letters.

All branches use `motion.button` with `whileTap={{ scale: 0.9 }}` and a small visual change (opacity / bg).

### 3.4 `src/components/GoogleIcon.jsx` (12 lines)

A pure inline SVG of the four-colour Google "G". Takes one optional prop:

```jsx
<GoogleIcon className="w-5 h-5" />   // default
```

Used inside `Login.jsx` for the "Continue with Google" button.

---

## 4. UI primitives (shadcn)

Seven files kept after the Phase 1.5 cleanup (the other 42 shadcn primitives were deleted because they were never imported outside `ui/`).

| File | Exports | Used by |
|---|---|---|
| `button.jsx` | `Button`, `buttonVariants` (cva) | Login, Register, ForgotPassword, ResetPassword, AuthLayout-wrapped pages |
| `input.jsx` | `Input` | every auth form, the contact-add form |
| `label.jsx` | `Label` (Radix wrapper) | auth form fields |
| `input-otp.jsx` | `InputOTP`, `InputOTPGroup`, `InputOTPSlot`, `InputOTPSeparator` | `Register.jsx` 6-digit OTP entry |
| `toast.jsx` | Radix primitives: `Toast`, `ToastTitle`, `ToastDescription`, `ToastAction`, `ToastClose`, `ToastProvider`, `ToastViewport` | re-exported via `toaster.jsx` |
| `toaster.jsx` | `<Toaster />` outlet — mounted at the top of `App.jsx` | implicit |
| `use-toast.jsx` | `useToast()` hook + standalone `toast()` function (reducer + listener pattern) | called via `useToast()` from inside Login/Register/Forgot/Reset on errors |

These follow the standard shadcn / Radix patterns — no custom modifications beyond what `npx shadcn-ui add` would produce.

> Note: SplitBill.jsx and Inbox.jsx do **not** use the shadcn `<Button>` / `<Input>`. They roll their own (`PrimaryBtn`, `GhostBtn`, `Card`, raw `<input>` / `<textarea>`) for stylistic consistency with the slice dark theme.

---

## 5. Cross-cutting libraries

### 5.1 `src/api/split.js` (124 lines)

Single fetch wrapper for every `/api/*` route. Helper:

```js
const j = (r) => r.json()
```

Every method returns the response JSON (no error wrapping — callers `.catch(() => {})` if they want to swallow).

**System:**

| Method | Verb | Path | Body shape |
|---|---|---|---|
| `status()` | GET | `/api/status` | — |
| `ledger()` | GET | `/api/ledger` | — |
| `reset()` | POST | `/api/reset` | — |

**Groups:**

| Method | Verb | Path | Body |
|---|---|---|---|
| `createGroup(name, members)` | POST | `/api/group` | `{ name, members }` |
| `updateGroup(id, { name, members })` | PATCH | `/api/group/{id}` | `{ name, members }` |
| `listMessages(groupId)` | GET | `/api/group/{groupId}/messages` | — |
| `sendMessage(groupId, sender, text)` | POST | `/api/group/{groupId}/message` | `{ sender, text }` |

**Bill / split:**

| Method | Verb | Path | Body |
|---|---|---|---|
| `bill(file?)` | POST | `/api/bill` | `FormData` with `image` if `file` given; empty body otherwise (server returns sample bill) |
| `command(text)` | POST | `/api/command` | `{ text }` |
| `preview(payload)` | POST | `/api/split/preview` | full preview payload |
| `confirm(payload)` | POST | `/api/split/confirm` | full confirm payload |
| `explain(payload)` | POST | `/api/explain` | `{ expenseId, person, question }` |

**Settlement / flag:**

| Method | Verb | Path | Body |
|---|---|---|---|
| `markPaid(id)` | POST | `/api/settlement/{id}/paid` | — |
| `flag({ settlementId, category, person, note, kind })` | POST | `/api/flag` | mirrors arg |
| `approveFlag(id)` | POST | `/api/flag/{id}/approve` | — |
| `rejectFlag(id, reason)` | POST | `/api/flag/{id}/reject` | `{ reason }` |

**Goals (Atom Split-to-Save):**

| Method | Verb | Path | Body |
|---|---|---|---|
| `goalFromSettlement(settlementId)` | POST | `/api/goal/from-settlement` | `{ settlementId }` |
| `fundGoal(name, amount)` | POST | `/api/goal/fund` | `{ name, amount }` |

**Contacts (in-app address book + WhatsApp/SMS deep-link invites):**

| Method | Verb | Path | Body |
|---|---|---|---|
| `listContacts()` | GET | `/api/contacts` | — |
| `addContact({ name, mobile, isSliceUser })` | POST | `/api/contacts` | mirrors arg |
| `updateContact(id, patch)` | PATCH | `/api/contacts/{id}` | `patch` |
| `removeContact(id)` | DELETE | `/api/contacts/{id}` | — |
| `resolveContact(token)` | GET | `/api/contacts/resolve?token={enc}` | — |
| `recordInviteSent(id, { channel, groupId })` | POST | `/api/contacts/{id}/invite-sent` | `{ channel, groupId }` |

Comments inside the file note Vite proxies `/api/*` → Express on `:5179` in dev; same-origin in prod (the Express server serves the built SPA from `dist/`).

### 5.2 `src/lib/voice.js` (31 lines)

Browser Web Speech API wrapper.

`createRecognizer({ onResult, onEnd, onError }) → recognizer | null`

| Param | Shape | Notes |
|---|---|---|
| `onResult` | `({ final, interim, text }) => void` | `text` is `(final \|\| interim).trim()` — the convenience aggregate every caller actually uses |
| `onEnd` | `(finalText: string) => void` | fired when STT stops; receives the trimmed final transcript |
| `onError` | `(err: string) => void` | string is whatever Web Speech reports, or `'speech error'` fallback |

Recogniser config: `lang = 'en-IN'`, `interimResults = true`, `continuous = false`. Returns `null` if `SpeechRecognition` isn't available (caller is expected to gate on `voiceSupported()`).

`voiceSupported() → boolean` — feature detection.

### 5.3 `src/lib/contacts.js` (133 lines)

Pure helpers backing the @mention dropdown + the WhatsApp / SMS deep-link invites. **All exports are pure functions** (no state, no fetch).

| Export | Signature | Behaviour / example |
|---|---|---|
| `normalizeMobile(raw)` | `(string) → string` | Strips non-digits. If exactly 10 digits, prepends `"91"` (India default). `"+91 98765 43210"` → `"919876543210"`. |
| `extractMentions(text)` | `(string) → string[]` | Regex-finds `@token`s where token is mobile-like or alpha + `[A-Za-z0-9_.-]{1,30}`. Returns tokens without the leading `@`. |
| `resolveMentionLocal(token, contacts)` | `(string, Contact[]) → Contact \| null` | Mobile-looking token → match by canonical mobile. Otherwise case-insensitive exact-then-prefix on `name`. |
| `getMentionTrigger(value, caret)` | `(string, number) → { active, query, start, end }` | Looks at the substring before the caret. If it ends in `(^|\s)@<chars>`, returns `active: true` + the in-progress query + slice bounds. Used to drive a live dropdown. |
| `filterContactsForMention(contacts, query)` | `(Contact[], string) → Contact[]` | Empty query → first 8. Otherwise: name substring (case-insensitive) OR mobile substring (digits-only). Caps at 8. |
| `applyMentionSelection(value, trigger, contact)` | `(string, Trigger, Contact) → { value, caret }` | Replaces the trigger slice with `"@<name> "` and returns the new caret position. |
| `buildWhatsAppLink(mobile, message)` | `(string, string) → string \| null` | `https://wa.me/<digits>?text=<urlenc>` (works on iOS / Android / web). |
| `buildSmsLink(mobile, message)` | `(string, string) → string \| null` | `sms:+<digits>?body=<urlenc>`. |
| `defaultInviteMessage({ groupName, fromName })` | `({string?, string?}) → string` | Templated invite copy referencing the optional group name. |
| `generateInviteCode()` | `() → string` | 6-char A–Z+0–9 minus `I`,`O`,`0`,`1` (unambiguous). |

### 5.4 `src/lib/utils.js` (9 lines)

```js
export function cn(...inputs) { return twMerge(clsx(inputs)) }
export const isIframe = window.self !== window.top
```

That's the entire module. `cn` is the standard shadcn class merger.

### 5.5 `src/hooks/use-mobile.jsx` (19 lines)

```js
useIsMobile() → boolean
```

`window.matchMedia('(max-width: 767px)')` at `MOBILE_BREAKPOINT = 768`. Subscribes to the `'change'` event. Returns `!!isMobile` (so the undefined initial state collapses to `false`). Not currently consumed by the main flows — kept for future responsive logic.

---

## 6. ⭐ Lender surface — `src/pages/SplitBill.jsx` (3 785 LOC)

The single biggest file. The default-exported `SplitBill` component renders everything; many internal helpers and overlays are defined in the same file. Six of those helpers (`GroupChat`, `FlagBanners`, `CreateExpenseSheet`) are **also re-exported** because `Inbox.jsx` imports them.

### 6.1 Container state — `<SplitBill>`

`useState`:

| Group | State |
|---|---|
| Identity / system | `status` (`{ mode, me, vpa }`), `toast`, `ledger`, `detail`, `openQr` |
| Mode | `mode` (`"solo" \| "group"`), `activeGroup`, `groupBusy` |
| Overlays | `aiChatOpen`, `contactsOpen`, `notifOpen`, `notifReadAt`, `manualOpen`, `editOpen` |
| Flow | `bill`, `billLoading`, `img`, `text`, `command`, `split`, `working`, `result` |
| Voice | `listening`, `transcript` |

`useRef`: `scanRef` (hidden file input, camera capture), `uploadRef` (hidden file input, gallery), `recRef` (recognizer instance).

`useMemo`: `contacts` (= `ledger?.contacts || []`), `myFlagRequests` (filtered to `payer === me`, newest first), `unreadNotifCount` (count where `createdAt > notifReadAt`).

`useEffect` (single bootstrap, deps `[]`):
1. `splitApi.status()` → `setStatus`.
2. `refreshLedger()` immediately, then `setInterval(refreshLedger, 1500)`.
3. Cleanup clears the interval.

Helpers defined in the component:

| Helper | Calls | Purpose |
|---|---|---|
| `flash(m)` | — | toast for 2 400 ms |
| `refreshLedger` | `splitApi.ledger()` | replaces ledger state |
| `markNotificationsRead()` | — | writes `Date.now()` to `localStorage['ss.notif.readAt']` + state |
| `switchMode(m)` | — | sets mode + clears `activeGroup` if going solo + `reset()` |
| `createGroup(name, members)` | `splitApi.createGroup` | sets `activeGroup` on success |
| `updateGroup(id, name, members)` | `splitApi.updateGroup` | |
| `scanBill(file)` | `splitApi.bill(file)` | sets `bill`, populates object-URL `img` |
| `runCommand(override?)` | `splitApi.command`, `splitApi.bill(null)`, `splitApi.preview` | full text-to-preview pipeline |
| `confirm()` | `splitApi.confirm` | persists the split + N settlements |
| `reset()` | — | clears bill/img/text/command/split/result/transcript |
| `toggleMic()` | `createRecognizer` | voice input on the inline command bar |

### 6.2 Render structure (top to bottom)

```
<div min-h-screen bg-background>
  Header (px-5 pt-6) ─ Slice Split title | Contacts button | Bell + unread badge | Solo/Group toggle
  Scrollable flow:
    FlagBanners                    ── recent-flag re-notification strip
    FlagReviewQueue                ── inline maker-checker for pending flags
    GroupPanel (if group mode)     ── list / create / view active
    Capture tiles (if no bill)     ── Scan | Upload | Add Expense | AI Chat
    Bill card (if bill)            ── merchant + items + edit/new
      LowConfidenceBanner          ── if OCR flagged any items
    Command card (if bill)         ── textarea + mic + Split It
    ItemAssignPanel (if split)     ── "Advanced split" tap-per-person
    Per-person split cards         ── inline UPI open + QR toggle
    Settlement (if result)         ── Goal banner + Ask-the-AI chat
    Ledger (if expenses exist)     ── Transactions | Settle up tabs
  </Scrollable flow>
  BottomNav

  AnimatePresence overlays:
    TransactionDetail (detail)
    NotificationsPanel (notifOpen)
    ContactsSheet (contactsOpen)
    AIChatSheet (aiChatOpen)
  Toast
  ManualExpenseSheet (manualOpen)
  BillEditSheet (editOpen)
</div>
```

### 6.3 Sub-components defined inside the file

| Component | Role | Key props |
|---|---|---|
| `SectionLabel`, `Card`, `Avatar`, `PrimaryBtn`, `GhostBtn`, `CaptureTile` | Local styled primitives | trivial |
| `<TransactionDetail expense onClose>` | Full-screen overlay slide-in from right; shows bill items + per-person breakdown | |
| `<Settlement result flash>` | Post-confirm AI chat panel; methods: `ask(person, question)` → `splitApi.explain` | local state: `explainPerson`, `chat`, `thinking`, `askText`, `listening`, `recRef` |
| `<Ledger ledger onSettle onOpen>` | Two-tab summary (Transactions / Settle up). `onSettle(id)` calls `splitApi.markPaid` via parent. | |
| `<GroupPanel groups expenses active busy onSelect onCreate onUpdate onOpen contacts>` | Group list / create / edit / show. **Includes the fixed `useEffect([active?.id])` that resets `creating` / `editing` / `name` / `members`** — see §6.5 bug-fix notes. The new-group "members" input embeds `<MentionSuggestions>`. | |
| `<GroupChat group me fixedSender? compact?>` *(exported)* | Reusable chat. Polls `splitApi.listMessages(groupId)` every 2 000 ms. `send()` → `splitApi.sendMessage`. Sender dropdown hidden if `fixedSender`. | |
| `<NotificationsPanel requests expenses me onClose onResolved flash>` | Slide-up overlay listing every flag where `payer === me`, newest first. Inline approve/reject with reason input; bill thumbnail when available. Status badges (Approved / Rejected with timestamps). | |
| `<ContactsSheet contacts me onClose onChanged flash>` | Slide-up address book. Permission gate (`localStorage['ss.contacts.perm']`), add/remove, per-row Invite → WhatsApp / SMS deep-link picker → `splitApi.recordInviteSent`. **Includes the "Test @mention" debug pane** showing live trigger state + per-token resolution + channel decision. | |
| `<MentionSuggestions trigger contacts alreadyPicked onPick onAddNew anchor>` | The live dropdown. Anchored above or below the input via `anchor: "top" \| "bottom"`. Empty states: typing prompt, no-match Add-New CTA, badges (`slice` ✅, `invite` 💜, `already added` ⚠️). | |
| `<AIChatSheet onClose flash onExecute contacts>` | The Sparkles-tile entry. Textarea + mic + Send. Voice **auto-fires** the intent parser on final transcript via `parseFromValue(cleaned)`. Confirmation card shown before `onExecute(plan)`. | |
| `<ItemAssignPanel bill split command onPreview flash>` | "Advanced split" panel. State: `assignments`, `pendingItems`, debounce timer ref + `requestSeq` to discard stale responses. Each cell change schedules a `splitApi.preview(...)` 220 ms later. | |
| `<LowConfidenceBanner bill onEdit>` | Amber banner when `bill.lowConfidence` is non-empty. "Looks good" dismisses; "Edit" opens the BillEditSheet. | |
| `<FlagReviewQueue flagRequests me onResolved flash>` | Inline lender queue — same approve/reject as NotificationsPanel but rendered in-page. Coexists by design. | |
| `<FlagBanners expenses forPerson?>` *(exported)* | Top-of-screen "Split corrected" strip. Reads `lastFlag` on each expense, filters to within 30 s. If `forPerson` is set (Inbox borrower use case), shows personal delta only. Auto-dismisses after ~20 s. | |
| `<ManualExpenseSheet open onCancel me groupMembers groupName onCreated flash>` | No-bill flow. Modes: `"equal" \| "custom" \| "percentage"`. Synthesises a one-line bill + command + calls `splitApi.preview` then hands it back to parent. | |
| `<BillEditSheet open bill split command me groupMembers onCancel onSaved flash>` | OCR correction. Live total recompute. On Save, calls `splitApi.preview` with the edited bill + people for live re-split. | |
| `<CreateExpenseSheet open onClose me group status ledger flash onConfirmed>` *(exported)* | Borrower-parity wrapper. Same flow as the lender's main pipeline but `me` is the borrower, no AI Chat tile, group name always tagged. Used inside `Inbox.jsx` group mode. | |

### 6.4 AI Chat — intent / action map

`AIChatSheet` defines a local `ACTION` map that mirrors the server's `intent` enum (see `server/claude.js`):

| Server `intent` | Client `ACTION` | What `onExecute` does in `<SplitBill>` |
|---|---|---|
| `create_group` | `CREATE_GROUP` | `splitApi.createGroup` → switch to group mode, set `activeGroup` |
| `create_group_and_split` | `CREATE_GROUP_AND_SPLIT` | same as above, then trigger `scanRef.current.click()` |
| `add_members` | `ADD_MEMBERS` | requires `activeGroup`; `splitApi.updateGroup` with merged members |
| `scan_and_split` | `SCAN_BILL_AND_SPLIT` | close sheet, trigger `scanRef.current.click()` |
| `upload_and_split` | `UPLOAD_BILL_AND_SPLIT` | close sheet, trigger `uploadRef.current.click()` |
| `add_expense` | `ADD_EXPENSE` | open `ManualExpenseSheet` |
| `save_towards` | `SAVE_TOWARDS` | `splitApi.fundGoal(plan.saveToGoal || 'My savings', 0)` — creates the goal at zero balance |
| `split` | `SPLIT_EXPENSE` | flash "Capture a bill first…" |
| `query` | `QUERY` | flash "Question received — ask in chat after a split" |
| `unknown` | `UNKNOWN` | flash "I'm not sure what to do with that — try again" |

### 6.5 Notable bug-fix history (for context)

The current code includes three deliberate fixes worth knowing:

1. **GroupPanel back nav** — `useEffect(() => { setCreating(false); setEditing(false); setName(''); setMembers(''); … }, [active?.id])`. Without this, hitting back from group-detail re-showed the stale "New group" form (which looked like Edit Group to the user). See commit `1b63cb5`.
2. **AI Chat black-screen** — the slide-up sheet now uses `text-foreground` + explicit `color: '#f4f1ff'` + `background: '#1a1622'` + `minHeight: 55vh` + backdrop `rgba(0,0,0,0.72)` + 2 px blur. The original `#13111a` background on the pure-black page made the modal invisible. Same fix applied to `ContactsSheet` and `NotificationsPanel`. See commit `1b63cb5`.
3. **Voice → auto-execute** — the mic's `onEnd` callback now calls `parseFromValue(cleaned)` automatically once the final transcript lands. Earlier the user had to tap Send. See commit `f565308`.

---

## 7. ⭐ Borrower surface — `src/pages/Inbox.jsx` (1 289 LOC)

Route `/inbox?as=<Name>` — the `?as=` query param tells the view which borrower's perspective to render (so multiple borrowers can share a demo URL by picking different names).

### 7.1 Container state — `<Inbox>`

| State | Initial | Purpose |
|---|---|---|
| `ledger` | `null` | polled every 1 500 ms from `splitApi.ledger()` |
| `paying` | `null` | settlement id currently in PIN authorisation |
| `expanded` | `{}` | `{ [settlementId]: boolean }` — which bill-details accordions are open |
| `pinFor` | `null` | the settlement currently in the `<UpiPinSheet>` |
| `explainFor` | `null` | the settlement currently in the `<ExplainSheet>` |
| `busyGoal` | `null` | settlement id currently being turned into a goal |
| `toast` | `""` | flash, 2 200 ms |
| `mode` | `"solo"` | `"solo" \| "group"` |
| `activeGroup` | `null` | the group currently being viewed |

`useMemo` derivations (all keyed on the polled `ledger`):

| Derivation | Definition |
|---|---|
| `expensesById` | `{ [exp.id]: exp }` lookup |
| `mine.pending` / `mine.settled` | `ledger.settlements` filtered to `from === asName` and split by `status` |
| `myGoals` | `ledger.goals` where `kind === 'payment' && borrower === asName` |
| `goalBySettlement` | `{ [settlementId]: goal }` — used to render inline progress bar |
| `settlementGoaled` | Set of settlement ids that already have a goal (hides "Save toward this") |
| `myFlags` | `ledger.flagRequests` where `actor === asName` |
| `pendingFlagBySettlement` | `{ [settlementId]: flag }` where status pending |
| `myGroups` | `ledger.groups` where `asName` is a member |
| `groupExpenses` / `groupExpenseIds` / `groupTotalSpent` / `groupMyShare` / `groupMySettlements` | scoped to `activeGroup` |

### 7.2 Helpers

| Function | API call | Purpose |
|---|---|---|
| `refresh()` | `splitApi.ledger` | polled every 1 500 ms |
| `turnIntoGoal(s)` | `splitApi.goalFromSettlement(s.id)` | converts a settlement into a contextually-named Atom goal |
| `fundGoal(g, amount)` | `splitApi.fundGoal(g.name, amount)` | the "+₹100", "+₹500", "Fund full" buttons |
| `clearGoal(g)` | `splitApi.markPaid(g.settlementId)` | once a goal is fully funded, one-tap settle |
| `switchMode(m)` | — | mirrors lender side; clears `activeGroup` on solo |
| `flash(m)` | — | toast 2 200 ms |

### 7.3 Sub-components defined in the file

| Component | Role |
|---|---|
| `<BillDetails exp>` | Line-item table + GST + service charge + total. Rendered inside the expandable settlement card. |
| `<FlagChip onClick loading>` | Quick-pick chip: "I left before dessert" / "I'm vegetarian" / "No drinks". Each pre-fills a flag category. |
| `<ExplainSheet settlement expense asName onCancel onFlagged>` | Bottom-sheet modal. Two sections: **Ask Claude** (chat, voice, quick prompts → `splitApi.explain`) and **Flag a line** (category chips + free-text note + voice → `splitApi.flag`). State: `chat`, `thinking`, `flagging`, `askText`, `noteText`, `listening`. |
| `<UpiPinSheet settlement expense onCancel onAuthorised>` | 4-digit PIN entry. State: `pin`, `phase` (`"entry" \| "authorising" \| "success"`). Phase transitions: PIN-complete → 550 ms spinner → 450 ms checkmark → `onAuthorised(s)` which calls `splitApi.markPaid(s.id)`. |
| `<BorrowerGroupDetail group asName ledger groupExpenses groupMySettlements ... onBack onRefresh flash>` | Subpage for group mode. Header with back arrow, member chips, "Create expense in this group" CTA → `<CreateExpenseSheet>`, stats card, pending list (same shape as solo), recent bills, settled-in-group section, `<GroupChat group me={asName} fixedSender compact>`. |

### 7.4 Render structure

```
Header ─ avatar + greeting + bell (count if pending > 0) + Solo/Group toggle
FlagBanners (forPerson = asName)
[Solo mode]
  Pending list (per settlement card):
    lender avatar + amount + bill title + relative time
    "Flag pending review" pill (if pendingFlagBySettlement[s.id])
    Goal progress bar (if goalBySettlement[s.id])
    "View bill details" → BillDetails expand
    Explain | Save toward this | Pay (PIN)
  Flags list (myFlags) ─ status icons, before/after share, reason
  Goals list (myGoals) ─ progress, +₹100/+₹500/Fund full, Clear one-tap when funded
  Settled list ─ last 8, faded
[Group mode, no activeGroup]
  Group cards ─ name, members, # bills, total spent, your share, pending count
[Group mode, activeGroup]
  <BorrowerGroupDetail .../>
ExplainSheet (if explainFor)
UpiPinSheet (if pinFor)
Toast
```

### 7.5 API calls (full enumeration)

- `splitApi.ledger()` — bootstrap + 1 500 ms polling
- `splitApi.goalFromSettlement(s.id)` — `turnIntoGoal`
- `splitApi.fundGoal(g.name, amount)` — `fundGoal`
- `splitApi.markPaid(g.settlementId)` — `clearGoal`
- `splitApi.explain({ expenseId, person, question })` — chat in `<ExplainSheet>`
- `splitApi.flag({ settlementId, category, person })` — category chips
- `splitApi.flag({ settlementId, person, note, kind: 'note' })` — free-text note
- `splitApi.markPaid(s.id)` — inside `onAuthorised(s)` after PIN succeeds
- Also imports `<GroupChat>`, `<FlagBanners>`, `<CreateExpenseSheet>` from `SplitBill.jsx`, which bring in: `splitApi.listMessages`, `splitApi.sendMessage`, plus everything `<CreateExpenseSheet>` invokes (`bill`, `command`, `preview`, `confirm`).

---

## 8. Dashboard stubs (`Home`, `Activity`, `Banking`, `Credit`, `Explore`)

These are slice-shell placeholders kept by user request (project memory note: future scope, do not delete).

| Page | LOC | What it renders | State |
|---|---|---|---|
| `Home.jsx` | 102 | Header (balance check / message / profile chips), large amount display, UPI pill, custom `<Numpad showDot>`, Receive / Transfer buttons, `<BottomNav>` | `amount` (string), updated by `handlePress` |
| `Activity.jsx` | 106 | Header, search bar, location permission banner, 6 hardcoded transaction cards (avatar / name / date / amount / status), `<BottomNav>` | `search` (filter, currently unbound to the static list) |
| `Banking.jsx` | 123 | 3 cards — Savings (with balanceVisible toggle), Fixed Deposits, Account details, `<BottomNav>`. Framer Motion stagger on entry. | `balanceVisible` |
| `Credit.jsx` | 101 | Animated UPI-credit card, Borrow / Purchase Power, Outstanding due, `<BottomNav>` | none |
| `Explore.jsx` | 174 | Two 4-grids (Recharge & Bills; More Services) + 2×2 utility cards (Rewards / June spends / Invite / Credit score / Autopay), `<BottomNav>` | none |

None of these talk to `splitApi` — they're visual fillers. The active routes from `BottomNav` work, so the demo "feels like an app" beyond just the bill-split tab.

---

## 9. Knowledge graph reference

Everything above can be queried directly off the indexed `.gitnexus/` knowledge graph. Useful one-liners:

```bash
# What does SplitBill call out to?
gitnexus context SplitBill

# All React functions over 200 lines
gitnexus cypher "MATCH (f:Function) WHERE f.endLine - f.startLine > 200 \
                 RETURN f.name, f.filePath, f.endLine - f.startLine AS len \
                 ORDER BY len DESC"

# Every caller of splitApi.confirm
gitnexus cypher "MATCH (caller)-[:CALLS]->(t {name:'confirm'}) \
                 RETURN caller.name, caller.filePath"

# Blast radius if you change something
gitnexus impact AIChatSheet
gitnexus impact splitApi
```

Live web UI: `gitnexus serve --port 4747` then https://gitnexus.vercel.app (auto-detects the local backend). Graph: **654 symbols, 1 000 edges, 19 clusters, 20 execution flows** at indexing time.

---

## 10. Glossary

| Term | Meaning in this codebase |
|---|---|
| **Lender** | The user who paid the bill upfront and is requesting reimbursement. UI lives at `/splitbill`. Identity comes from `splitApi.status().me`. |
| **Borrower** | A person who owes a share. UI lives at `/inbox?as=<Name>`. |
| **Settlement** | One row in the ledger representing `<from>` owes `<to>` `₹<amount>` for `<expenseId>`. Status: `requested` → `settled`. |
| **Flag** | A borrower's dispute on a settlement. Two kinds: `category` (e.g. "I didn't have dessert") and `note` (free-text). Goes through a maker-checker queue. |
| **Goal** | An Atom Split-to-Save target. `goalFromSettlement` creates one named e.g. `"Lend Repayment - Mohit"` (solo) or `"Group Bill Split - Goa Trip"` (group). |
| **Itemized / Ratio / Equal** | The three modes of `splitEngine` on the server. Mirrored in `command.mode`. |
| **`asName`** | URL `?as=<name>` param in Inbox — identifies "which borrower I am" for the demo. |
| **`ME`** | Server-side identity of the lender process (`server/index.js` env). Surfaces on the client as `status.me`. |

---

## 11. Related docs

- [HLD.md](./HLD.md) — executive view (system, actors, principles, integration boundaries).
- [LLD.md](./LLD.md) — backend modules, route contracts, persistence schemas. **Server-side companion to this doc.**
- [INTEGRATIONS.md](./INTEGRATIONS.md) — Mermaid sequence diagrams for the five end-to-end flows.
- [PHASE2_ARCH_REVIEW.md](./PHASE2_ARCH_REVIEW.md) — production-readiness audit.
- [PHASE2_DB_SELECTION.md](./PHASE2_DB_SELECTION.md) — Postgres + Neon + pgvector recommendation.
- [PHASE2_PLAN.md](./PHASE2_PLAN.md) — five-PR rollout plan.
- [PHASE3_ATOM_INTEGRATION.md](./PHASE3_ATOM_INTEGRATION.md) — Slice Atom × SliceSplit feature rewrite.
- [COMPONENTS.md](./COMPONENTS.md) — earlier component catalogue (pre-AI-Chat/contacts/notifications). **Superseded by this doc.**
