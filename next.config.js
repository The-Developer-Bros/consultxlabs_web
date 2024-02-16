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
    ],
  },
  // headers: async () => {
  //   return [
  //     {
  //       source: "/(.*)",
  //       headers: [
  //         {
  //           key: "Access-Control-Allow-Origin",
  //           value: "*",
  //         },
  //       ],
  //     },
  //   ];
  // },
};
