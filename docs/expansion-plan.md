# Ask Lotus: multi-hotel expansion plan

Approved by Akash on 2026-11-05 from the clickable prototype ("Ask Lotus Expansion" design canvas).
Build all of it; it goes live only after full testing.

## Hotels

| id  | name                       | brand       | system   |
|-----|----------------------------|-------------|----------|
| hop | Hampton Inn Overland Park  | hilton      | pep      |
| hlm | Hotel Lotus Merriam        | independent | hotelkey |
| hls | Hotel Lotus Stadium        | independent | hotelkey |

PEP is Hilton's name for HotelKey NextGen. Front desk at Hampton says "PEP"; at Merriam/Stadium say "HotelKey".
Hampton stays exactly as it is today (live, same SOP text). Merriam and Stadium start in setup ("new").

## Roles (lowest to highest)

- **Front Desk**: chat only, for their hotel(s).
- **Manager**: edit SOP wording/photos, team (Front Desk + Manager), activity, contacts, for their hotel(s).
- **GM** (hotel admin): everything a Manager does for their hotel(s), plus: run setup, turn SOPs on/off,
  hotel details, accept/keep master updates, hotel-only SOPs, import into their hotel, manage GM-and-below users of their hotel.
- **Owner**: everything everywhere: all hotels, add hotels, assign GMs, master library, imports into the master,
  AI settings. Existing role `Admin` migrates to `Owner`.

## Data model

### `hotels` (extend)
`brand text default 'independent'` (`hilton`|`independent`), `system text default 'hotelkey'` (`pep`|`hotelkey`),
`setup text default 'new'` (`new`|`setup`|`live`), `answers jsonb default '{}'` (setup answers:
`{breakfast:bool,pool:bool,pets:bool,laundry:bool,market:bool}`), `details jsonb default '{}'` (hotel details,
key → value, e.g. `{"Breakfast hours":"6–10 AM"}`). Keep `ready` in sync: `ready = (setup = 'live')`.

### `master_sops` (new): the Owner's library
`id text pk` (same ids as today, e.g. CI-01), `category`, `title`, `steps jsonb` = `[{ "t": "...", "hk": "..."|null, "img": id|null }]`
(`t` = PEP/default text, `hk` = HotelKey version of that step, null = same text), `script`, `script_hk`, `flag`, `flag_hk`,
`keywords`, `applies text` (`all`|`hilton`), `requires text null` (`breakfast`|`pool`|`pets`|`laundry`|`market`),
`hk_status text` (`same`|`draft`|`approved`: whether the HotelKey wording needs review), `version int`, `updated_at`, `updated_by`.
Master categories: `master_categories (name pk, prefix, sort)`.

### `sops` (extend): each hotel's own copy, what staff see
Add `master_id text null` (null = hotel-only SOP), `master_version int null` (the master version this copy is based on or
was last reviewed against), `kept boolean default false` (GM chose "keep mine" or edited locally; then master changes
show as updates instead of overwriting). Status gains `off`: `live`|`draft`|`off`. Staff see only `live`.

### Text tokens
`{Role}` resolves from the hotel's contacts (as today). `{Detail name}` resolves from `hotels.details`.
A token with no value renders as "ask a manager" (same look as `[FILL]`). Resolution happens at render/ask time,
so editing a detail updates every SOP. Contacts win if a name collides.

## Flows

### Seeding / migration (idempotent, prod-safe)
- Load `db/seed-data/master-sops.json` into `master_sops` + `master_categories` only if `master_sops` is empty.
- Hampton: `system='pep', brand='hilton', setup='live'`, details from `hampton_details` in the JSON (only if details empty).
  Link its existing sops: `master_id = id, master_version = 1` where a master SOP with that id exists and master_id is null.
  Hotel-only SOPs (e.g. CI-24, written by Akash) stay `master_id = null`.
- Re-create `hlm` and `hls` if missing (they were deleted from prod on 2026-11-04; nothing referenced them).
- `users.role` check becomes `('Front Desk','Manager','GM','Owner')`; `UPDATE users SET role='Owner' WHERE role='Admin'`.
  Seed's first admin is created as Owner.

### Choosing SOPs for a hotel (used by setup questions, copy, and review)
An SOP is suggested ON when `(applies='all' or hotel.brand='hilton')` and `(requires is null or answers[requires])`.

### Go live (GM, end of setup)
Materialize every master SOP into the hotel's `sops` (status `live` if selected else `off`), choosing for each step
`hk ?? t` when hotel.system='hotelkey', else `t` (same for script/flag), `master_version = master.version`, `kept=false`.
Copy master categories into the hotel's categories. Seed default routes/contacts if the hotel has none (empty contacts;
routes like Hampton's). Set `setup='live'`, `ready=true`.
"Copy another hotel": selection = the master_ids that are `live` at the source hotel; then the same review screen.

### After live
- Toggling on/off flips `status` between `live` and `off`.
- Master edit (Owner) bumps `master_sops.version`. A hotel copy with `master_version < master.version` is an **update**:
  GM sees it on Hotel home: **Accept** (overwrite the copy's content from the master with the hotel's system variant;
  set master_version; kept=false) or **Keep mine** (master_version = master.version; kept=true).
- A GM/Manager editing a hotel copy that has a master_id sets `kept=true`.

## Screens (match the prototype)
Owner: **Hotels** (portfolio cards, invite GM = create GM user for that hotel with temp password, add hotel),
**Master library** (filters: all / every hotel / Hilton-PEP only / depends on amenities / has PEP+HotelKey versions /
HotelKey needs review; master editor with a PEP | HotelKey toggle per SOP showing per-step HotelKey text; applies/requires
pickers; approve HotelKey wording), **Import**.
GM: **Setup start** (questions or copy), **About your hotel** (system shown read-only from the hotel record; amenities;
details), **Review and go live** (category switches, expand for single SOPs, still-needed details, contacts link),
**Hotel home** (updates from Lotus with Accept/Keep, tiles to SOPs on/off, Hotel details, Contacts, add hotel-only SOP).
Existing Manager tabs (Library, Unanswered, Activity, Team, Contacts) stay for the selected hotel.
Owner can switch hotel with the property menu (now multi-hotel again); hotels in setup can't be selected for chat.

## Import (Owner → master, GM → their hotel only)
1. **Upload documents (AI)**: PDF, Word (.docx), Excel (.xlsx/.csv), plain text. Server extracts text, sends it with the
   catalog (ids + titles) to the configured AI, which returns JSON: `matches` (existing SOP id + proposed steps + one-line
   difference), `new` (title, category, steps, script, flag), `details` (key, value). Results are reviewed in groups:
   matches → Keep ours / Use theirs; new → Add as draft (one or all); details → Use for this hotel.
   Needs an AI key; without one, explain that and point to the spreadsheet.
2. **Spreadsheet template**: downloadable .xlsx with columns Title, Category, Applies to, Requires, Step 1..Step 12,
   Say it like this, Call a manager if. Upload → preview rows as drafts, flag rows whose title matches an existing SOP.
Imported items are always drafts until approved.
