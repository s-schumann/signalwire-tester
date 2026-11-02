# Node 22.23.4 includes the October 2026 security fixes. Update tag and digest together.
FROM node:22.23.4-alpine3.24@sha256:fe4f6d74e20370acb04ad889077d14d0f64a9c8ea6a42bc60cddf1e844699914 AS runtime

# Keep the copied libraries current; Alpine backported CVE-2026-107891 in r3.
RUN apk add --no-cache --upgrade 'musl>=1.2.6-r3' libgcc libstdc++ ca-certificates-bundle

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN mkdir -p /app/data && chown -R 1000:1000 /app
# Retain package records for the libraries actually copied into scratch so
# vulnerability scanners can identify them without shipping the package manager.
RUN mkdir -p /runtime-metadata/lib/apk/db && \
    awk 'BEGIN { RS=""; ORS="\n\n" } /\nP:(musl|libgcc|libstdc\+\+|ca-certificates-bundle)\n/ { print }' \
      /lib/apk/db/installed > /runtime-metadata/lib/apk/db/installed

FROM scratch

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
WORKDIR /app

COPY --from=runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=runtime /lib/ld-musl-*.so.1 /lib/
COPY --from=runtime /usr/lib/libstdc++.so.6 /usr/lib/
COPY --from=runtime /usr/lib/libgcc_s.so.1 /usr/lib/
COPY --from=runtime /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=runtime /etc/os-release /etc/alpine-release /etc/
COPY --from=runtime /runtime-metadata/ /
COPY --from=runtime --chown=1000:1000 /app /app

USER 1000:1000
EXPOSE 3000

CMD ["node", "src/server.js"]
