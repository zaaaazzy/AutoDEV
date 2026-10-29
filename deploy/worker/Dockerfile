# Worker und Ausfall-Wächter als Compose-Dienste (Profil worker, docker-compose.yml). Das Image enthält nur Werkzeuge:
# Node in derselben Version wie API und Agent-Image, Git, SSH, gh sowie Docker-CLI mit Compose und Buildx (über den
# eingebundenen Socket). Den Code lädt der Worker aus dem eingebundenen AIdeation-Ordner – so bringt „AIdeation neu
# starten“ neuen Code ohne neues Image (Exit-Code 75, Docker startet den Container neu).
FROM node:22.22.3-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl git openssh-client tini \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli.gpg \
    && chmod a+r /etc/apt/keyrings/docker.asc /etc/apt/keyrings/githubcli.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian bookworm stable" \
      > /etc/apt/sources.list.d/docker.list \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update \
    && apt-get install -y --no-install-recommends docker-ce-cli docker-compose-plugin docker-buildx-plugin gh \
    && rm -rf /var/lib/apt/lists/*
# Eingebundene Ordner gehören dem Benutzer des Hosts, nicht dem des Containers: Git soll sie trotzdem lesen.
RUN git config --system --add safe.directory '*'
# Home für jede UID (der Container läuft mit der UID des Host-Benutzers, die hier keinen Eintrag hat): npm-Cache,
# Git-Zugänge (schreibgeschützt eingebunden) und der Zustand des Wächters (Volume) liegen hier.
RUN mkdir -p /home/worker && chmod 1777 /home/worker
ENV HOME=/home/worker \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false
COPY entrypoint.sh /usr/local/bin/aideation-worker
RUN chmod 755 /usr/local/bin/aideation-worker
USER node
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/aideation-worker"]
CMD ["worker"]
