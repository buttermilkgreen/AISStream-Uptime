# Use the exact match for your local working version
FROM node:20.20.2-slim

# Install temporary build tools required to compile native C++ addons like sqlite3
RUN apt-get update && apt-get install -y \
    python3 \
    make \
    g++ \
    && rm -rf /var/lib/apt/lists/*

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy application manifests
COPY package*.json ./

# Install production dependencies and force a custom build of the sqlite3 binary
RUN npm ci --omit=dev --build-from-source=sqlite3

# Copy the application source code
COPY . .

# Set default production environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the application port
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]