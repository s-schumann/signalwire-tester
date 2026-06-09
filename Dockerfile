FROM node:22-alpine AS runtime

WORKDIR /app

COPY package.json ./
COPY src ./src

RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx
RUN mkdir -p /app/data && chown -R 1000:1000 /app

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
COPY --from=runtime --chown=1000:1000 /app /app

USER 1000:1000
EXPOSE 3000

CMD ["node", "src/server.js"]
