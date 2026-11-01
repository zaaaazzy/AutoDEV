# Review-Container: startet einen beliebigen Commit eines Projekts zum Ansehen (eigener Port, eigene Datenbank).
# Eingebunden sind nur die Git-Objekte des Projekts (schreibgeschützt unter /source/objects, ohne Arbeitsordner und
# .env); der gewählte Stand wird nach /work ausgecheckt, Abhängigkeiten installiert (Linux-Binärdateien, daher nicht
# die des Macs) und der Review-Befehl gestartet – als Benutzer „node“, nicht als root.
FROM node:26.13.0-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
# Ohne root: /work und der npm-Cache (je Projekt eigenes Volume, siehe review-slots.ts) gehören dem Benutzer node.
RUN mkdir -p /work /home/node/.npm && chown node:node /work /home/node/.npm
COPY entrypoint.sh /usr/local/bin/review-entrypoint
USER node
ENTRYPOINT ["sh", "/usr/local/bin/review-entrypoint"]
