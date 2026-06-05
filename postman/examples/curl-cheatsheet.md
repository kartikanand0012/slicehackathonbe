# cURL cheatsheet

Quick sanity tests that don't require Postman. All paths are prefixed with `/api/v1`.

```bash
# Health
curl -s http://localhost:4000/api/v1/health/live
curl -s http://localhost:4000/api/v1/health/ready

# Register (returns accessToken + refreshToken)
curl -s -X POST http://localhost:4000/api/v1/auth/register \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","name":"Alice","password":"sup3rs3cret","phone":"+919876543210"}'

# Login
ACCESS=$(curl -s -X POST http://localhost:4000/api/v1/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"alice@example.com","password":"sup3rs3cret"}' | jq -r .accessToken)

# Me
curl -s http://localhost:4000/api/v1/me -H "Authorization: Bearer $ACCESS"

# Create group
curl -s -X POST http://localhost:4000/api/v1/groups \
  -H "Authorization: Bearer $ACCESS" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Goa Trip","emoji":"🏖️","simplifyDebts":true}'
```
