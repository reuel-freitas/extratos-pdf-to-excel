/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack: (config) => {
    // pdfjs-dist depends on canvas in Node — alias it away for browser builds
    config.resolve.alias.canvas = false;
    return config;
  },
};

export default nextConfig;
