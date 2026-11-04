# Ask Lotus

Front desk SOP assistant for Lotus Hospitality. Staff ask a question and get the hotel's own procedure, step by step. Managers edit SOPs line by line (with photos), manage the team and contacts, and see who asked what.

## Stack
Node 22 + Express, Postgres (Neon), sessions in Postgres. Plain HTML/CSS/JS front end in `public/` (no build step). Hosted on Render.

## Run locally
```
cp .env.example .env   # fill in values
npm install
npm run setup          # migrate + seed (Hampton Inn Overland Park, 234 SOPs, contacts, first admin)
npm start              # http://localhost:3000
```

## Roles
- **Front Desk**: chat only
- **Manager**: SOPs, team, contacts, activity for their hotels
- **Admin**: everything, including AI settings

## AI
Off by default: answers use keyword matching. An Admin can add a key for Anthropic, OpenAI, Google, Azure OpenAI or any OpenAI-compatible endpoint in Settings. The model only picks which SOP answers; staff always see the SOP text as managers wrote it. Keys are encrypted with `APP_SECRET`.

## SOP text tokens
- `{AGM}`, `{GM}`, any contact role in braces: replaced with name, role and phone from Contacts
- `[FILL: ...]`: shown to staff as "ask a manager" until filled in
- `[CHECK ...]`: manager note, hidden from staff
