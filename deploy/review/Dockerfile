# Review-Container: startet einen beliebigen Commit eines Projekts zum Ansehen (eigener Port, eigene Datenbank-Kopie).
# Der Source-Ordner des Projekts ist schreibgeschützt unter /source eingebunden; der gewählte Stand wird nach /work
# geklont, Abhängigkeiten installiert (Linux-Binärdateien, daher nicht die des Macs) und der Review-Befehl gestartet.
FROM node:22.22.3-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY entrypoint.sh /usr/local/bin/review-entrypoint
ENTRYPOINT ["sh", "/usr/local/bin/review-entrypoint"]
