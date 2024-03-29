# ConsultX - The One-stop Platform for Mentors, Advisors, Teachers, and Students

ConsultX is going to be the one-stop platform for all experts, mentors, coaches, consultants, teachers and advisors to share their wisdom with the masses.
Kind of like Swiggy with different restaurants for people.

## Setting Up Environment Variables for Development

Welcome to our development team! To help you get started, we've outlined the essential environment variables you need to configure for our projects. These environment variables are used to securely store sensitive information like API keys, secrets, and credentials.

### Prerequisites:

Before you start, make sure you have the following installed and configured on your development machine:

```
- Node.js (version 18 or higher)
- npm or yarn
- Git
```

## Step 1: Clone the Project Repository

First, clone the project repository from our version control system (e.g., GitHub, Bitbucket, or GitLab) to your local machine.

```bash
# Please clone using SSH instead of HTTPS (since we'll be making the repository private later on)
git clone <repository_url>
cd <repository_directory>
```

## Step 2: Create a .env File

Create a `.env` file in the root directory of the project. This file will contain all the environment variables you need to set up. For security reasons, this file is not committed to the project repository. We'll be taking variables from `.env.sample` file and putting them in the `.env` file.

### The NextAuth.js Variables

```bash
NEXTAUTH_URL="http://localhost:3000"
NEXTAUTH_SECRET="anything"
JWT_SECRET="anything"
```

### The OAuth Variables (Google, Github, Facebook)

You can manually create OAuth apps for Google, Github, and Facebook. Or you can use the ones we have already created. If you want to use the ones we have already created, then ask the team for the credentials. If you want to create your own OAuth apps, then follow the instructions below.

```bash
# You can ask the team for the credentials
GOOGLE_CLIENT_ID="your_google_client_id"
GOOGLE_CLIENT_SECRET="your_google_client_secret"

GITHUB_CLIENT_ID="your_github_client_id"
GITHUB_CLIENT_SECRET="your_github_client_secret"

FACEBOOK_CLIENT_ID="your_facebook_client_id"
FACEBOOK_CLIENT_SECRET="your_facebook_client_secret"
```

### Supabase Database Variables

You need to log in to Supabase with the ConsultX account where we have already created a database. Then go to the database settings scroll down to the bottom and click on the connect button. Copy the connection string and paste it into the `.env` file.

```bash
# You can ask the team for the connection string
DATABASE_URL="your_supabase_connection_string"
DIRECT_URL="your_supabase_direct_url"
```

## Docker [Not working yet]

Use this approach if you want to run the project in a Docker container.
This is useful if:

- you cannot install Node.js and npm on your machine
- you want to run the project in an isolated environment
- the experiments you are running could potentially break your machine or your OS
- the experiments you are running could potentially break your Node.js or npm installation
- you want to run the project on a different OS than the one you are using.

### Running it through just docker

```bash
# Build and run
docker build -t consultx-docker .
docker run -p 3000:3000 consultx-docker
```

### Running it through docker-compose

```bash
# Get latest docker
sudo snap refresh docker --channel=latest/edge\n

# Build and run
docker compose up --build
```
