# Start with the official Node.js image.
FROM node:latest

# Set the working directory in the Docker container.
WORKDIR /usr/src/app

# Copy the package.json and package-lock.json files (needed for production).
COPY package*.json ./

# Install the application dependencies.
RUN npm install

# Copy the application files (needed for production) [except for node_modules].
COPY . .

# Build the Next.js application.
RUN npm run build

# The application listens on port 3000, so let's expose it.
EXPOSE 3000

# Define the command to run the application.
CMD [ "npm", "run", "start-watch" ]
