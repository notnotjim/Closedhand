# Bot service (index.js) — Telegram polling, agents, pulse, data sync, the
# web-chat WebSocket server, and the platform webhook server.

# Image generation on a computer with an NVIDIA graphics card
# (lib/image-generation.js): stable-diffusion.cpp built for Vulkan, which the
# card runs, pinned to the release the Mac uses. Built here because its own
# Linux build needs a newer system than this image's. Debian 12's Vulkan
# headers are too old for it, so Khronos's are used at the version upstream
# builds with (Ubuntu 24.04's, 1.3.275); headers only, nothing changes at run
# time. Built for any x86-64 processor, not the one building it, two files at
# a time: ggml's Vulkan code takes several GB to compile, and many at once ran
# out of memory. For amd64 only, where such computers are; elsewhere the
# folder is empty and image generation says what it needs.
FROM debian:bookworm-slim AS stable-diffusion
ARG TARGETARCH
ARG SDCPP_REF=master-1043-3be2378
ARG VULKAN_HEADERS_REF=v1.3.275
RUN mkdir -p /opt/stable-diffusion && if [ "$TARGETARCH" = "amd64" ]; then \
      apt-get update && apt-get install -y --no-install-recommends ca-certificates git cmake g++ make libvulkan-dev glslc spirv-headers \
      && git clone --depth 1 --branch "$VULKAN_HEADERS_REF" https://github.com/KhronosGroup/Vulkan-Headers /vulkan-headers \
      && cmake -S /vulkan-headers -B /vulkan-headers/build && cmake --install /vulkan-headers/build --prefix /opt/vulkan-headers \
      && git clone --depth 1 --branch "$SDCPP_REF" --recurse-submodules https://github.com/leejet/stable-diffusion.cpp /src \
      && cmake -S /src -B /build -DSD_VULKAN=ON -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release -DVulkan_INCLUDE_DIR=/opt/vulkan-headers/include \
      && cmake --build /build --config Release -j2 --target sd-cli \
      && cp /build/bin/sd-cli /opt/stable-diffusion/; \
    fi

FROM node:22-slim

WORKDIR /app

# Install production deps first for better layer caching.
COPY package.json package-lock.json ./
ARG TARGETARCH
# The file reader (lib/file-reader.js) needs one build of each engine:
# PDF.js's legacy build and Tesseract's plain builds with English; the rest of
# those packages (other builds, source maps, a viewer, the Alpine Linux build
# of the drawing library) is 75MB nothing loads. npm's download cache goes too:
# it held 54MB of copies in every image.
#
# The local-models worker pulls in a machine-learning runtime that ships native
# binaries for macOS, Windows and Linux, on two architectures each. A Linux
# container needs exactly one of them, and the rest are roughly 200MB that
# every self-hoster would otherwise download on their first install. Pruned in
# the same layer as the install, because deleting them in a later one would
# leave them in the image anyway.
#
# Written to be unable to break a build: if the package or its layout is not
# what is expected here, find matches nothing and the image is unchanged. The
# architecture prune only runs when the builder tells us what it is building
# for, so a plain docker build keeps every Linux binary and stays correct.
RUN npm ci --omit=dev \
 && ONNX=node_modules/onnxruntime-node/bin \
 && if [ -d "$ONNX" ]; then \
      find "$ONNX" -mindepth 2 -maxdepth 2 -type d ! -name linux -prune -exec rm -rf {} + ; \
      case "${TARGETARCH:-}" in \
        arm64) find "$ONNX" -mindepth 3 -maxdepth 3 -type d ! -name arm64 -prune -exec rm -rf {} + ;; \
        amd64) find "$ONNX" -mindepth 3 -maxdepth 3 -type d ! -name x64   -prune -exec rm -rf {} + ;; \
      esac; \
    fi \
 && rm -rf node_modules/pdfjs-dist/build node_modules/pdfjs-dist/web node_modules/pdfjs-dist/image_decoders node_modules/@tesseract.js-data/eng/4.0.0 node_modules/@napi-rs/canvas-*-musl /root/.npm \
 && { find node_modules/pdfjs-dist node_modules/tesseract.js-core -name "*.map" -type f -delete 2>/dev/null; \
      find node_modules/tesseract.js-core -maxdepth 1 -type f \( -name "tesseract-core*-lstm*" -o -name "tesseract-core*.wasm.js" \) -delete 2>/dev/null; true; }

# MCP servers the user connects by command run inside this container. npx is
# already here with node; uv brings uvx for the Python ones (it fetches its own
# Python on first use). Their caches sit on the storage volume so a restart
# does not download everything again.
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /usr/local/bin/

# The system CA bundle. Node carries its own roots, but the slim image ships
# none for anything else the bot runs: the bundled Google Workspace CLI failed
# every call with "invalid peer certificate: UnknownIssuer" and Gmail search
# fell back to plain HTTP each time, and command-style MCP servers need it too.
# heif-convert turns iPhone photos (HEIC) into JPEGs for the file reader.
# libvulkan1 and libgomp1 run stable-diffusion.cpp on a graphics card; the
# card's own driver comes from the computer, handed in by docker-compose.gpu.yml.
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates libheif-examples libvulkan1 libgomp1 \
 && rm -rf /var/lib/apt/lists/*
COPY --from=stable-diffusion /opt/stable-diffusion /opt/stable-diffusion
ENV npm_config_cache=/data/storage/cache/npm \
    UV_CACHE_DIR=/data/storage/cache/uv \
    UV_PYTHON_INSTALL_DIR=/data/storage/cache/uv-python

# App source (see .dockerignore for exclusions).
COPY . .
RUN node scripts/prepare-voice.js && node scripts/prepare-voice.js --listening
# The commit this image was built from, for bug reports.
ARG GIT_SHA=""
ENV CLOSEDHAND_SHA=$GIT_SHA
# Closedhand's own Google app (see lib/google-app.js), passed in by the
# official image build. A build from source leaves both empty and connects
# Google through the person's own project.
ARG CLOSEDHAND_GOOGLE_CLIENT_ID=""
ARG CLOSEDHAND_GOOGLE_CLIENT_SECRET=""
ENV CLOSEDHAND_GOOGLE_CLIENT_ID=$CLOSEDHAND_GOOGLE_CLIENT_ID \
    CLOSEDHAND_GOOGLE_CLIENT_SECRET=$CLOSEDHAND_GOOGLE_CLIENT_SECRET

# Boot-with-nothing: the bot starts with no keys into setup mode. The port serves
# /health, the platform webhooks, and the /chat WebSocket (exposed to the host so
# the browser can connect directly).
EXPOSE 3000

CMD ["node", "index.js"]
