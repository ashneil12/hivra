#!/bin/sh
set -eu

GUACD_IMAGE='guacamole/guacd@sha256:f39258e35244b6bf79bc6ac4e60eee176aea6f6a5adb13e8c3090e48df8ae515'
WEB_IMAGE='guacamole/guacamole@sha256:50484043eadd8d9562053940c0ed523dbddaf9086c370127b2f4acabb8bddddc'
JSON_SECRET='00000000000000000000000000000000'
fixture_id="$$"
fixture_network="hivra-guacamole-${fixture_id}"
fixture_guacd="hivra-guacd-${fixture_id}"
fixture_web="hivra-guacamole-web-${fixture_id}"

cleanup_fixture() {
  docker rm -f "$fixture_web" "$fixture_guacd" >/dev/null 2>&1 || true
  docker network rm "$fixture_network" >/dev/null 2>&1 || true
}
trap cleanup_fixture EXIT HUP INT TERM

docker image inspect "$GUACD_IMAGE" "$WEB_IMAGE" >/dev/null
docker network create --internal "$fixture_network" >/dev/null
docker run -d --platform linux/amd64 --name "$fixture_guacd" --network "$fixture_network" "$GUACD_IMAGE" >/dev/null
docker run -d --platform linux/amd64 --name "$fixture_web" --network "$fixture_network" \
  -e GUACD_HOSTNAME="$fixture_guacd" \
  -e JSON_ENABLED=true \
  -e JSON_SECRET_KEY="$JSON_SECRET" \
  "$WEB_IMAGE" >/dev/null

ready=0
attempt=1
while [ "$attempt" -le 30 ]; do
  http_code=$(docker exec "$fixture_web" curl -sS -o /dev/null -w '%{http_code}' \
    http://127.0.0.1:8080/guacamole/ 2>/dev/null || true)
  if [ "$http_code" = 200 ]; then
    ready=1
    break
  fi
  attempt=$((attempt + 1))
  sleep 1
done
[ "$ready" = 1 ]

fixture_password="fixture-${fixture_id}-not-a-live-secret"
fixture_token=$(HIVRA_GUACAMOLE_JSON_SECRET="$JSON_SECRET" \
  HIVRA_GUACAMOLE_EXPIRES="$(( $(date +%s) * 1000 + 30000 ))" \
  HIVRA_FIXTURE_RDP_PASSWORD="$fixture_password" \
  HIVRA_GUACAMOLE_STREAMING_MODE=hq \
  node "$(dirname "$0")/guacamole-json-token.mjs")
token_response=$(docker exec -e HIVRA_JSON_TOKEN="$fixture_token" "$fixture_web" sh -c \
  'curl -sS --fail-with-body --data-urlencode "data=$HIVRA_JSON_TOKEN" http://127.0.0.1:8080/guacamole/api/tokens')

HIVRA_TOKEN_RESPONSE="$token_response" node -e '
  const value = JSON.parse(process.env.HIVRA_TOKEN_RESPONSE);
  if (typeof value.authToken !== "string" || value.authToken.length < 16) process.exit(1);
  if (value.username !== "hivra-fixture-owner") process.exit(1);
  const raw = JSON.stringify(value);
  if (raw.includes("10.242.5.4") || raw.includes("not-a-live-secret")) process.exit(1);
'

guacd_version=$(docker exec "$fixture_guacd" /opt/guacamole/sbin/guacd -v 2>&1)
case "$guacd_version" in
  *"1.6.0"*) ;;
  *) exit 1 ;;
esac

json_extension_sha=$(docker exec "$fixture_web" sha256sum \
  /opt/guacamole/extensions/guacamole-auth-json/guacamole-auth-json.jar | awk '{print $1}')
[ "$json_extension_sha" = '541dd411e2ba28564c31728728201b90805318880b2e63bcb4b4f23bf808318d' ]

echo 'Guacamole 1.6.0 JSON-auth runtime: PASS'
