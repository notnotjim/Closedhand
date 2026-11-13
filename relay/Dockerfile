# The relay for personal URLs (relay.js), on its own: no packages beyond Node.
FROM node:22-slim
WORKDIR /relay
COPY package.json main.js relay.js sni.js proxy.js ./
USER node
CMD ["node", "main.js"]
