# Coyote Culinária TexMex — Backend

Stack: Node.js 20+, Express 5, Prisma 6, PostgreSQL, Server-Sent Events para tempo real, bcrypt para senhas, sessões opacas em cookie httpOnly, RBAC (CUSTOMER < STAFF < MANAGER < OWNER), rate limiting e Helmet.

Status: código escrito, **ainda não executado** neste ambiente. Siga os passos abaixo e verifique cada um.

## Estrutura
- `prisma/schema.prisma` — modelo do banco
- `prisma/seed.js` — cria o proprietário e, com `--demo`, carrega dados de demonstração
- `src/server.js` — app, segurança e rotas
- `src/routes/` — auth, menu, orders (cliente), admin (painel)
- `src/middleware/auth.js` — sessão e permissões
- `public/index.html` — site público (ainda usa carrinho local; a ligação com a API é a próxima etapa)

## Rodar localmente
1. Tenha um PostgreSQL acessível e coloque a URL em `DATABASE_URL` no arquivo `.env` (copie de `.env.example`).
2. `npm install`
3. `npx prisma db push`
4. `ADMIN_EMAIL=... ADMIN_PASSWORD=... npm run seed` (crie o proprietário; senha com 12+ caracteres)
5. Opcional: `npm run seed:demo`
6. `npm run dev` e abra http://localhost:3000

## E-mail de recuperação de senha
1. Crie uma conta no Resend e verifique um domínio próprio.
2. Defina `RESEND_API_KEY` e `MAIL_FROM` (ex.: `Coyote <nao-responda@seudominio.com.br>`).
3. Em produção, sem essas variáveis o envio falha e o erro aparece nos logs do Render. Em desenvolvimento, o e-mail é impresso no console.
4. Teste: peça a recuperação no site e confira se o e-mail chega. O link vale 30 minutos.

## Testes rápidos (com a aplicação rodando)
    curl -s localhost:3000/health
    curl -s localhost:3000/api/menu
    curl -s -c jar.txt -H 'Content-Type: application/json' -d '{"email":"dono@exemplo.com","password":"SUA_SENHA"}' localhost:3000/api/auth/login
    curl -s -b jar.txt localhost:3000/api/admin/dashboard
    curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/api/admin/dashboard   # esperado: 401

## Publicar no GitHub e Render
1. Suba esta pasta como repositório no GitHub (com `package-lock.json` gerado pelo `npm install`).
2. No Render: New → Blueprint → selecione o repositório. O `render.yaml` cria o web service e o PostgreSQL.
3. Em Environment, preencha `PUBLIC_URL` (URL do serviço), `ADMIN_EMAIL` e `ADMIN_PASSWORD`.
4. Após o primeiro deploy, abra o Shell do serviço e rode `npm run seed`. Depois remova `ADMIN_PASSWORD` das variáveis.
5. O banco gratuito do Render expira após 30 dias. Para produção, troque para um plano pago.

## Não implementado ainda
- Mercado Pago (Pix e cartão). Os pagamentos ficam como `DEMO / PENDING`.
- Painel administrativo em tela (as rotas de API existem).
- Gestão de promoções e cupons, financeiro com exportação CSV/PDF e recuperação de senha.
- Páginas de privacidade, termos e alergênicos (precisam de texto revisado por advogado e pelo restaurante).
- Ligação do site público com a API.
