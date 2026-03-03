FROM node:20-bookworm

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      python3 \
      python3-venv \
      python3-pip \
      git \
      ca-certificates \
      bash \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

CMD ["bash"]
