FROM docker.io/cloudflare/sandbox:0.7.2

# Pre-install the goose-pond app so containers start with deps ready
RUN git clone --depth 1 https://github.com/ghostwriternr/goose-pond.git /home/user/goose-pond
WORKDIR /home/user/goose-pond
RUN npm install

# Required during local development to access exposed ports
EXPOSE 5173
EXPOSE 8080
