import axios from "axios";
import type { VercelRequest, VercelResponse } from "@vercel/node";

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const { url } = req.query;

  if (!url || typeof url !== "string") {
    return res.status(400).json({ error: "URL is required" });
  }

  try {
    const response = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
        "Accept-Language": "en-US,en;q=0.9,vi;q=0.8",
        "Referer": new URL(url).origin,
        "Cache-Control": "max-age=0",
      },
      timeout: 25000,
      maxRedirects: 10,
    });

    // Vercel serverless functions have limits, so we send the HTML
    res.setHeader("Content-Type", "text/html");
    res.status(200).send(response.data);
  } catch (error: any) {
    console.error("Proxy error for URL:", url, error.message);
    
    const statusCode = error.response?.status || 500;
    const errorMessage = error.response?.data || error.message;
    
    res.status(statusCode).json({ 
      error: "Failed to fetch content from the provided URL",
      details: errorMessage,
      url: url
    });
  }
}
