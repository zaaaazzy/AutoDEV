# aideation_proxy_caddy: Caddy ohne root. Zertifikate und Konfiguration (/data, /config) gehören dem Benutzer caddy;
# bestehende, noch root-eigene Volumes übergibt der Dienst https-volumes in docker-compose.yml vor dem Start.
FROM caddy:2.8.4-alpine
RUN (getent group caddy || addgroup -S caddy) \
    && (id caddy || adduser -S -D -H -h /data -G caddy caddy) \
    && chown -R caddy:caddy /data /config
USER caddy
