# Bruno e Renata

Projeto preparado para o fluxo **GitHub → Vercel → Supabase**.

## 1) GitHub
Suba os arquivos para um repositório novo. Não suba `.env` ou chaves secretas.

## 2) Vercel — antes do Supabase
Importe o repositório do GitHub na Vercel e faça o primeiro deploy **sem variáveis**.

O site deve abrir normalmente. O formulário ainda não grava porque o banco não existe.

Teste `/api/health`. Antes do Supabase deve retornar `ok: true`, `database: "not_configured"` e `databaseConfigured: false`.

## 3) Supabase
1. Crie o projeto.
2. No SQL Editor execute `supabase/migrations/20260925000000_create_requests.sql`.
3. Na Vercel adicione em Production:

```env
SUPABASE_URL=https://SEU-PROJETO.supabase.co
SUPABASE_SECRET_KEY=sb_secret_...
ADMIN_USER=admin
ADMIN_PASSWORD=SUA_SENHA_FORTE
ADMIN_SESSION_SECRET=UM_SEGREDO_COM_PELO_MENOS_32_CARACTERES
```

4. Faça Redeploy.
5. `/api/health` deve mostrar `database: "supabase"` e `databaseConfigured: true`.

## Segurança
- Nunca envie `SUPABASE_SECRET_KEY` ao GitHub.
- A Secret Key fica apenas nas Environment Variables da Vercel.
- `.env` já está ignorado pelo Git.
