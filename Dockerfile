# Use the official Node.js 20 LTS base image (Debian-based, matching the host OS)
FROM node:20-slim

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy application manifests
COPY package*.json ./

# Install production dependencies
RUN npm ci --omit=dev

# Copy the application source code
COPY . .

# Set default production environment variables
ENV NODE_ENV=production
ENV PORT=3000

# Expose the application port
EXPOSE 3000

# Start the application
CMD [ "npm", "start" ]
