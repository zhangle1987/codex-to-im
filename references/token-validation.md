# Token Validation Commands

After writing `config.env`, validate each enabled platform's credentials to catch typos and configuration errors early.

## Feishu / Lark

```bash
curl -s -X POST "${DOMAIN}/open-apis/auth/v3/tenant_access_token/internal" \
  -H "Content-Type: application/json" \
  -d '{"app_id":"...","app_secret":"..."}'
```

Expected: response contains `"code":0`. If not, check that App ID, App Secret, and site/domain match the Feishu Developer Console.

## Weixin

Weixin uses the local linked-account store instead of a bot token. Validate it with:

```bash
codex-to-im status
```

If no linked account is available, run:

```bash
cd /path/to/codex-to-im
npm run weixin:login
```
