# PatchSensei

AI-powered artwork review + mockup generation, embedded inside Shopify Admin
for Ninja Patches.

This is the new native Shopify embedded app — Remix + Polaris on top of the
existing PatchSensei Lambda workers (1, 1B, 2, 2B). The legacy `Lambda 3`
HTML overlay is being retired in favor of this app.

## Stack
- Remix v2 (Vite) + TypeScript
- `@shopify/shopify-app-remix` for OAuth, session tokens, App Bridge
- Polaris for UI
- Prisma + SQLite for Shopify session storage
- AWS SDK v3 for talking to Lambda 1B (Ranker), Lambda 2B (RankMockup),
  SQS (mockup queue), S3 (mockup bucket), DynamoDB (rank-sessions)

## Routes

| Path                | Purpose                                              |
| ------------------- | ---------------------------------------------------- |
| `/app`              | Overview — pending/approved/can't-do counts          |
| `/app/queue`        | Orders awaiting AI review (`PATCHSENSEI-REVIEW` tag) |
| `/app/orders/$id`   | Order detail with Approve / Can't do actions         |
| `/app/approved`     | Approved orders                                      |
| `/app/analytics`    | Approval rate, backlog, lifetime totals              |
| `/app/settings`     | Auto-approve threshold, notifications                |
| `/app/mockup-lab`   | Upload artwork → AI ranks 21 styles → top-3 mockups  |
| `/auth/*`           | Standard Shopify OAuth                               |
| `/webhooks/*`       | app/uninstalled + 3 GDPR compliance webhooks         |

## Environment variables

```
SHOPIFY_API_KEY         Shopify Partners → Apps → PatchSensei → Client ID
SHOPIFY_API_SECRET      Shopify Partners → Apps → PatchSensei → Client secret
SHOPIFY_APP_URL         Public URL of this app (ECS / ALB DNS)
SCOPES                  read_orders,write_orders,read_products,write_products
DATABASE_URL            file:./dev.sqlite           (dev) or postgres://… (prod)

# AWS — workers
LAMBDA_RANKER_NAME      PatchSensei-Ranker
SQS_QUEUE_URL           https://sqs.us-east-1.amazonaws.com/795462798032/PatchSenseiMockupQueue
SQS_RANKUP_QUEUE_URL    https://sqs.us-east-1.amazonaws.com/795462798032/PatchSenseiRankMockupQueue
S3_MOCKUP_BUCKET        ninja-patchsensei-mockups
DYNAMO_RANK_TABLE       PatchSensei-RankSessions
NINJA_RANKER_SECRET     <set on ECS task>
AWS_REGION              us-east-1
```

## Local development

```bash
npm install
npx prisma generate
npx prisma migrate dev
npm run dev
```

## Production build

```bash
docker build -t patch-sensei-app .
docker run -p 3000:3000 --env-file .env patch-sensei-app
```

## Deployment target
AWS ECS Fargate behind an ALB. Container reads env vars from Parameter Store
or Secrets Manager. The task role needs:
- `lambda:InvokeFunction` on `PatchSensei-Ranker`
- `sqs:SendMessage` on `PatchSenseiMockupQueue` and `PatchSenseiRankMockupQueue`
- `s3:PutObject`, `s3:GetObject` on `ninja-patchsensei-mockups`
- `dynamodb:GetItem` on `PatchSensei-RankSessions`

## Reference
`REFERENCE_dashboard.html` is the legacy Lambda 3 single-file dashboard.
Kept in the repo as the source of truth for what each tab needs to do.
Delete once feature parity is reached.
