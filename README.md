# Collection — Funil de Conversão

Dashboard em tempo real para acompanhar o funil de conversão da Collection.

## Etapas do Funil

1. **Cadastro** — signup_completed
2. **Email Confirmado** — email_confirmed
3. **Onboarding Iniciado** — onboarding_started
4. **Onboarding Completo** — onboarding_completed
5. **Instalador Aberto** — installer_opened
6. **Login no Instalador** — installer_login
7. **Plugin Instalado** — plugin_installed

## Stack

- Next.js 15 (App Router)
- Tailwind CSS 4
- Supabase (funnel_events table)
- Auto-refresh a cada 30 segundos

## Deploy

```bash
npm install
npm run build
vercel --prod
```
