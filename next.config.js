/** @type {import('next').NextConfig} */
module.exports = {
  // images: {
  //   domains: ["lh3.googleusercontent.com", "firebasestorage.googleapis.com"],
  // },
  images: {
    remotePatterns: [
      {
        hostname: "lh3.googleusercontent.com",
      },
      {
        hostname: "firebasestorage.googleapis.com",
      },
      {
        hostname: "spyhtvtmrektuyogsxze.supabase.co",
      },
    ],
  },
};