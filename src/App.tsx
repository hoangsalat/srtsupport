import React, { useState, useEffect, useRef } from "react";
import { 
  Search, 
  Download, 
  Settings, 
  Play, 
  Trash2, 
  CheckCircle2, 
  Loader2, 
  AlertCircle,
  FileText,
  Table as TableIcon,
  ChevronRight,
  BookOpen,
  ArrowRight,
  XCircle,
  Split,
  Upload,
  Files,
  Scissors,
  RotateCcw
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import axios from "axios";
import { GoogleGenAI } from "@google/genai";
import { saveAs } from "file-saver";

// --- Types ---
interface Chapter {
  title: string;
  content: string;
  url: string;
}

interface SrtEntry {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
  duration: number;
  charCount: number;
}

// --- Constants ---
const GEMINI_MODEL = "gemini-3-flash-preview";

// --- Utils ---
const formatSrtTime = (seconds: number): string => {
  const date = new Date(0);
  date.setMilliseconds(seconds * 1000);
  const hours = Math.floor(seconds / 3600).toString().padStart(2, "0");
  const mins = date.getUTCMinutes().toString().padStart(2, "0");
  const secs = date.getUTCSeconds().toString().padStart(2, "0");
  const ms = date.getUTCMilliseconds().toString().padStart(3, "0");
  return `${hours}:${mins}:${secs},${ms}`;
};

const calculateDuration = (charCount: number): number => {
  if (charCount < 30) return 2.0;
  if (charCount <= 50) return 3.0; // 2.5 - 3.5
  if (charCount <= 80) return 4.0; // 3.5 - 4.5
  if (charCount <= 120) return 5.4; // 4.8 - 6.0
  if (charCount <= 160) return 6.7; // 6.0 - 7.5
  if (charCount <= 220) return 8.5; // 7.5 - 9.5
  return 10.0; // Should be split if > 220
};

export default function App() {
  const [urls, setUrls] = useState<string[]>([""]);
  const [isScraping, setIsScraping] = useState(false);
  const [isProcessingAI, setIsProcessingAI] = useState(false);
  const [chapters, setChapters] = useState<Chapter[]>([]);
  const [srtData, setSrtData] = useState<SrtEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState({ current: 0, total: 0, message: "Sẵn sàng" });
  
  // --- Mode States ---
  const [activeMode, setActiveMode] = useState<'transformer' | 'splitter'>('transformer');
  const [splitCount, setSplitCount] = useState<2 | 4>(2);
  const [splitResults, setSplitResults] = useState<string[][]>([]); // Blocks of SRT
  const [isSplitting, setIsSplitting] = useState(false);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [rawSrtContent, setRawSrtContent] = useState<string | null>(null);
  const [suggestedTitle, setSuggestedTitle] = useState<string | null>(null);

  const abortControllerRef = useRef<AbortController | null>(null);

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

  const addUrlField = () => setUrls([...urls, ""]);
  const removeUrlField = (index: number) => {
    if (urls.length > 1) {
      const newUrls = [...urls];
      newUrls.splice(index, 1);
      setUrls(newUrls);
    }
  };
  const updateUrlField = (index: number, val: string) => {
    const newUrls = [...urls];
    newUrls[index] = val;
    setUrls(newUrls);
  };

  // --- Logic Functions ---

  const scrapeNovel = async () => {
    const activeUrls = urls.filter(u => u.trim() !== "");
    if (activeUrls.length === 0) {
      setError("Vui lòng nhập ít nhất một đường dẫn truyện chữ");
      return;
    }

    setIsScraping(true);
    setError(null);
    setChapters([]);
    setSrtData([]);
    setProgress({ current: 0, total: 0, message: "Khởi động crawler..." });

    let collected: Chapter[] = [];
    // maxChaptersPerLink limit has been removed for truly infinite scraping

    try {
      for (const startUrl of activeUrls) {
        let currentUrl = startUrl;

        while (currentUrl) {
          setProgress(prev => ({ ...prev, message: `Quét chương ${collected.length + 1}...` }));
          
          const response = await axios.get(`/api/proxy?url=${encodeURIComponent(currentUrl)}`);
          const html = response.data;
          const parser = new DOMParser();
          const doc = parser.parseFromString(html, "text/html");

          let title = doc.querySelector("h1, h2, .title, .chapter-title")?.textContent?.trim() || `Chương ${collected.length + 1}`;
          let contentSelectors = [".chapter-c", ".box-chap", ".chapter-content", "#chapter-content", ".content", ".entry-content", ".reading-content", "article", ".post-content"];
          let rawContent = "";
          
          for (let selector of contentSelectors) {
            const el = doc.querySelector(selector);
            if (el) {
              const clone = el.cloneNode(true) as HTMLElement;
              // Remove unwanted UI elements but keep all story text
              clone.querySelectorAll("script, style, iframe, .ads, .advertisement, .fb-quote, .social-share").forEach(e => e.remove());
              
              // Standardize paragraph ends to double newlines
              clone.querySelectorAll("p, div, br").forEach(e => {
                const nl = doc.createTextNode("\n");
                e.parentNode?.insertBefore(nl, e.nextSibling);
              });

              const text = clone.textContent || "";
              if (text.trim().length > 100) {
                rawContent = text;
                break;
              }
            }
          }

          if (!rawContent) {
            const divs = Array.from(doc.querySelectorAll("div"));
            let candidates = divs.map(div => {
              const pCount = div.querySelectorAll("p").length;
              return { text: div.textContent || "", score: pCount * (div.textContent?.length || 0) };
            });
            candidates.sort((a, b) => b.score - a.score);
            if (candidates.length > 0) rawContent = candidates[0].text;
          }

          let content = rawContent
            .replace(/\r\n/g, "\n")
            .replace(/[ \t]+/g, " ") // Clean horizontal whitespace
            .replace(/\n\s*\n/g, "\n\n") // Normalize double newlines
            .trim();

          if (content.length > 50) {
            collected.push({ title, content, url: currentUrl });
            setChapters([...collected]);
            setProgress(prev => ({ ...prev, current: collected.length }));
          }

          let nextLink = "";
          const links = Array.from(doc.querySelectorAll("a"));
          for (const el of links) {
            const text = el.textContent?.toLowerCase() || "";
            if (text.includes("chương tiếp") || text.includes("tiếp theo") || text.includes("next chapter") || text.includes("next >") || text.includes("next »")) {
              const href = el.getAttribute("href");
              if (href && !href.startsWith("javascript") && href !== "#") {
                try {
                  nextLink = new URL(href, currentUrl).href;
                } catch (e) {
                  nextLink = href;
                }
                break;
              }
            }
          }

          if (nextLink && nextLink !== currentUrl) {
            currentUrl = nextLink;
          } else {
            currentUrl = "";
          }
        }
      }
      setProgress(prev => ({ ...prev, message: "Thu thập tất cả hoàn tất!" }));
      if (collected.length === 0) {
        setError("Không tìm thấy nội dung truyện. Vui lòng kiểm tra lại link.");
      }
    } catch (err: any) {
      const detail = err.response?.data?.details || err.message;
      setError(`Lỗi scraping: ${detail}`);
    } finally {
      setIsScraping(false);
      // Generate suggested title if we have data
      if (collected.length > 0) {
        generateSuggestedTitle(collected);
      }
    }
  };

  const generateSuggestedTitle = async (data: Chapter[] = chapters) => {
    if (data.length === 0) return;
    try {
      setProgress(prev => ({ ...prev, message: "Đang phân tích để tạo tên truyện hấp dẫn..." }));
      // Use more chapters if available for better context, up to 5
      const sampleText = data.slice(0, 5).map(c => c.content).join("\n").substring(0, 7000);
      
      const prompt = `
        Dựa trên nội dung truyện sau, hãy đề xuất 1 tên truyện NGẮN GỌN (dưới 10 từ), cực kỳ thu hút người đọc và mang tính "viral" cao trên mạng xã hội.
        
        YÊU CẦU QUAN TRỌNG: 
        Trong tên truyện PHẢI xuất hiện ít nhất một từ hoặc cụm từ chỉ nhân vật hấp dẫn như: 
        'Bạch Nguyệt Quang', 'Thanh Mai Trúc Mã', 'Vợ Chồng', 'Tổng Tài', 'Ảnh Đế', 'Sư Phụ', 'Tiền Bối', 'Tiểu Thư', 'Gia Chủ', 'Nữ Phụ', 'Nam Phụ', 'Phản Diện', 'Tra Nam', 'Tiện Nữ', 'Lão Đại', 'Phu Nhân', 'Mẹ Kế', 'Ba Nuôi', 'Con Nuôi'...
        hoặc các danh xưng tương tự phù hợp nhất với bối cảnh câu chuyện.
        
        Chỉ trả về duy nhất 1 cái tên, không thêm bất kỳ ký tự nào khác (không ngoặc kép, không lời dẫn).
        
        NỘI DUNG TRUYỆN:
        ${sampleText}
      `;

      const response = await (ai as any).models.generateContent({
        model: GEMINI_MODEL,
        contents: [{ role: "user", parts: [{ text: prompt }] }],
      });
      const title = response.text || (response.response && response.response.text && response.response.text()) || "";
      setSuggestedTitle(title.trim().replace(/^"|"$/g, ''));
      setProgress(prev => ({ ...prev, message: "Đã gợi ý tên truyện mới!" }));
    } catch (err) {
      console.error("Lỗi tạo tên gợi ý:", err);
      setProgress(prev => ({ ...prev, message: "Lỗi khi tạo tên gợi ý." }));
    }
  };

  const processWithAI = async () => {
    if (chapters.length === 0) {
      setError("Vui lòng quét dữ liệu trước khi chuyển hóa.");
      return;
    }

    setIsProcessingAI(true);
    setError(null);
    setProgress(prev => ({ ...prev, message: "Đang chuẩn bị nội dung..." }));
    
    abortControllerRef.current = new AbortController();

    // Logic for 100% original content transformation
    let fullText = chapters.map(c => c.content).join("\n\n");
    setProgress(prev => ({ ...prev, message: "Đang tạo SRT từ nội dung gốc..." }));
    generateSRT(fullText);
    setProgress(prev => ({ ...prev, message: "Hoàn tất chuyển hóa nội dung!" }));
    setIsProcessingAI(false);
  };

  const cancelProcessing = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsProcessingAI(false);
      setIsScraping(false);
      setProgress(prev => ({ ...prev, message: "Đang hủy..." }));
    }
  };

  const generateSRT = (text: string) => {
    // 1. First split by line breaks to preserve initial structure
    const lines = text.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
    const cleanedSegments: string[] = [];

    // 2. Break down long lines into smaller chunks (max 150 chars for better AI reading)
    lines.forEach(line => {
      let current = line;
      const MAX_LEN = 150; 
      
      while (current.length > 0) {
        if (current.length <= MAX_LEN) {
          cleanedSegments.push(current);
          current = "";
        } else {
          // Find last space within MAX_LEN to avoid cutting words
          let splitIdx = current.lastIndexOf(" ", MAX_LEN);
          if (splitIdx === -1 || splitIdx < 30) splitIdx = MAX_LEN; // Fallback if no clean space
          
          cleanedSegments.push(current.substring(0, splitIdx).trim());
          current = current.substring(splitIdx).trim();
        }
      }
    });

    let currentTime = 0;
    const entries: SrtEntry[] = [];

    cleanedSegments.forEach((seg) => {
      const duration = calculateDuration(seg.length);
      entries.push({
        index: entries.length + 1,
        startTime: formatSrtTime(currentTime),
        endTime: formatSrtTime(currentTime + duration),
        text: seg,
        duration: duration,
        charCount: seg.length
      });
      currentTime += duration;
    });

    setSrtData(entries);
  };

  const downloadSrt = () => {
    const content = srtData.map(e => 
      `${e.index}\n${e.startTime} --> ${e.endTime}\n${e.text}\n`
    ).join("\n");
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    saveAs(blob, "novel_transform.srt");
  };

  const handleSrtSplit = (content: string, count: number) => {
    setIsSplitting(true);
    setError(null);
    try {
      // Split by double newline to get blocks
      const rawBlocks = content.trim().split(/\r?\n\s*\r?\n/);
      const blocks = rawBlocks.filter(b => b.trim().length > 5);
      
      if (blocks.length < count) {
        throw new Error("File SRT quá ngắn để chia nhỏ.");
      }

      const total = blocks.length;
      const size = Math.ceil(total / count);
      const results: string[][] = [];

      for (let i = 0; i < count; i++) {
        const start = i * size;
        const end = Math.min(start + size, total);
        if (start < total) {
          results.push(blocks.slice(start, end));
        }
      }

      setSplitResults(results);
      setProgress({ current: 0, total: results.length, message: "Chia nhỏ hoàn tất!" });
    } catch (err: any) {
      setError(`Lỗi chia file: ${err.message}`);
    } finally {
      setIsSplitting(false);
    }
  };

  useEffect(() => {
    if (rawSrtContent && activeMode === 'splitter') {
      handleSrtSplit(rawSrtContent, splitCount);
    }
  }, [splitCount, rawSrtContent, activeMode]);

  const onFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadedFileName(file.name);
    const reader = new FileReader();
    reader.onload = (event) => {
      const content = event.target?.result as string;
      setRawSrtContent(content);
    };
    reader.readAsText(file);
  };

  const downloadSplitPart = (index: number) => {
    const blocks = splitResults[index];
    const content = blocks.join("\n\n");
    const name = uploadedFileName ? uploadedFileName.replace(".srt", "") : "splitted";
    const blob = new Blob([content], { type: "text/plain;charset=utf-8" });
    saveAs(blob, `${name}_part_${index + 1}.srt`);
  };

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-art-bg text-art-ink font-art-sans select-none">
      {/* HEADER SECTION - COMPACTED */}
      <header className="p-4 lg:px-10 border-b-2 border-art-ink flex justify-between items-center bg-art-bg z-10 shrink-0">
        <div className="flex items-center gap-6">
          <div className="hidden sm:block">
            <p className="text-[10px] font-bold uppercase tracking-[2px] text-art-accent mb-1">
              Creative Automation Tool
            </p>
            <h1 className="text-[20px] font-black leading-[0.9] tracking-[-1px] uppercase whitespace-nowrap">
              TRUYỆN CHỮ TRANSFORMER
            </h1>
            <p className="text-[9px] font-bold uppercase opacity-40 mt-1">100% Original Content Mode</p>
          </div>
          <div className="h-10 w-px bg-art-ink/10 hidden sm:block"></div>
          
          {/* Mode Selector */}
          <div className="flex bg-gray-100 p-1 rounded-sm border border-art-ink/10">
            <button 
              onClick={() => setActiveMode('transformer')}
              className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                activeMode === 'transformer' ? 'bg-white shadow-sm text-art-accent' : 'text-art-ink/50 hover:text-art-ink'
              }`}
            >
              Transformer
            </button>
            <button 
              onClick={() => setActiveMode('splitter')}
              className={`px-4 py-1.5 text-[10px] font-black uppercase tracking-widest transition-all ${
                activeMode === 'splitter' ? 'bg-white shadow-sm text-art-accent' : 'text-art-ink/50 hover:text-art-ink'
              }`}
            >
              SRT Splitter
            </button>
          </div>
        </div>
        <div className="flex items-center gap-4">
          {activeMode === 'transformer' && (
            <button 
              onClick={downloadSrt}
              disabled={srtData.length === 0}
              className="art-btn px-6 py-2 disabled:opacity-30 disabled:cursor-not-allowed shadow-[2px_2px_0_0_#1a1a1a]"
            >
              <Download size={16} />
              Tải File .SRT
            </button>
          )}
        </div>
      </header>

      {/* CORE CONTAINER */}
      <div className="flex flex-1 overflow-hidden">
        {/* SIDEBAR SIDE */}
        <aside className="w-[340px] art-border !border-t-0 !border-l-0 !border-b-0 p-6 flex flex-col gap-6 bg-[#fafafa] overflow-y-auto">
          
          {activeMode === 'transformer' ? (
            <>
              {/* Transformer Inputs */}
              <div className="space-y-4">
                <div className="flex justify-between items-center">
                  <label className="art-label mb-0">Danh Sách Link Truyện</label>
                  <button 
                    onClick={addUrlField}
                    className="text-[10px] uppercase font-bold text-art-accent hover:underline"
                  >
                    + Thêm Link
                  </button>
                </div>
                <div className="space-y-3">
                  {urls.map((u, i) => (
                    <div key={i} className="flex gap-2 relative group">
                      <input 
                        type="text" 
                        value={u}
                        onChange={(e) => updateUrlField(i, e.target.value)}
                        placeholder={`Link truyện ${i + 1}`}
                        className="art-input w-full pr-10 text-xs"
                      />
                      {urls.length > 1 && (
                        <button 
                          onClick={() => removeUrlField(i)}
                          className="absolute right-3 top-1/2 -translate-y-1/2 text-art-ink/30 hover:text-red-500"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                <button 
                  onClick={scrapeNovel}
                  disabled={isScraping || urls.every(u => !u)}
                  className="art-btn w-full py-3"
                >
                  {isScraping ? <Loader2 className="animate-spin" size={16} /> : <Search size={16} />}
                  Quét Dữ Liệu
                </button>
              </div>

              {/* Suggested Title Box */}
              <AnimatePresence>
                {suggestedTitle && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="art-border p-6 relative bg-art-bg mt-2 border-art-accent shadow-[4px_4px_0_0_#ff4d4d]"
                  >
                    <span className="absolute -top-3 left-3 bg-art-accent text-white px-2 py-0.5 text-[9px] font-black uppercase flex items-center gap-1">
                      <CheckCircle2 size={10} /> Tên Gợi Ý AI
                    </span>
                    
                    <button 
                      onClick={() => generateSuggestedTitle()}
                      title="Tạo tên mới"
                      className="absolute -top-3 right-3 bg-art-ink text-white p-1 hover:bg-art-accent transition-colors border border-art-ink"
                    >
                      <RotateCcw size={12} />
                    </button>
                    
                    <div className="space-y-4">
                      <div className="bg-gray-50 p-4 border border-art-ink/10 rounded-sm">
                        <p className="text-[13px] font-black leading-tight text-center italic">
                          "{suggestedTitle}"
                        </p>
                      </div>
                      
                      <p className="text-[10px] opacity-70 leading-relaxed font-bold text-center uppercase tracking-tighter">
                        Đã tối ưu với từ khóa nhân vật thu hút người đọc
                      </p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Execution Group */}
              <div className="space-y-4">
                <label className="art-label">Cấu Hình SRT</label>
                <div className="text-[11px] border border-dashed border-art-ink p-3 bg-white font-medium">
                  Mặc định: 35 ký tự/giây<br />Khoảng cách: 0ms (Liền kề)
                </div>
                <div className="space-y-2">
                  <button 
                    onClick={processWithAI}
                    disabled={isProcessingAI || isScraping}
                    className={`art-btn w-full py-4 shadow-[4px_4px_0_0_#1a1a1a] ${
                      chapters.length > 0 
                      ? "!bg-art-accent !text-white !border-art-accent" 
                      : "!bg-gray-200 !text-gray-400 !border-gray-200 cursor-not-allowed"
                    }`}
                  >
                    {isProcessingAI ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} fill="currentColor" />}
                    Bắt Đầu Chuyển Hóa
                  </button>
                  {chapters.length === 0 && !isScraping && (
                    <p className="text-[10px] text-center font-bold text-art-accent animate-pulse">
                      * Cần quét dữ liệu trước khi chuyển hóa
                    </p>
                  )}
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Splitter Inputs */}
              <div className="space-y-6">
                <div>
                  <label className="art-label">Tải Lên File SRT</label>
                  <label className="flex flex-col items-center justify-center h-32 w-full border-2 border-dashed border-art-ink/20 bg-white hover:bg-art-bg transition-colors cursor-pointer group">
                    <Upload size={24} className="text-art-ink/30 mb-2 group-hover:text-art-accent group-hover:scale-110 transition-all" />
                    <span className="text-[10px] font-black uppercase text-art-ink/50 group-hover:text-art-ink">
                      {uploadedFileName || "Chọn file .srt"}
                    </span>
                    <input type="file" accept=".srt" className="hidden" onChange={onFileUpload} />
                  </label>
                </div>

                <div className="space-y-3">
                  <label className="art-label">Số Lượng File Cần Chia</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button 
                      onClick={() => setSplitCount(2)}
                      className={`art-btn !text-[11px] py-4 shadow-[4px_4px_0_0_#1a1a1a] ${splitCount === 2 ? "!bg-art-accent !text-white !border-art-accent" : "!bg-white"}`}
                    >
                      Chia Đôi (2 File)
                    </button>
                    <button 
                      onClick={() => setSplitCount(4)}
                      className={`art-btn !text-[11px] py-4 shadow-[4px_4px_0_0_#1a1a1a] ${splitCount === 4 ? "!bg-art-accent !text-white !border-art-accent" : "!bg-white"}`}
                    >
                      Chia Tư (4 File)
                    </button>
                  </div>
                </div>

                {splitResults.length > 0 && (
                  <div className="space-y-3 pt-4 border-t border-art-ink/10">
                    <label className="art-label flex items-center gap-2">
                       <Download size={12} /> Tải Các Bản Chia Nhỏ
                    </label>
                    <div className="grid grid-cols-1 gap-2">
                      {splitResults.map((_, idx) => (
                        <button 
                          key={idx}
                          onClick={() => downloadSplitPart(idx)}
                          className="art-btn !text-[10px] py-3 !bg-white hover:!bg-art-accent hover:!text-white group justify-between"
                        >
                          <span className="flex items-center gap-2">
                            <FileText size={12} /> Part {idx + 1}
                          </span>
                          <Download size={12} className="opacity-30 group-hover:opacity-100" />
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}

          {error && (
            <div className="p-4 border-2 border-red-500 bg-red-50 text-red-600 text-xs font-bold uppercase flex items-center gap-2">
              <AlertCircle size={14} />
              {error}
            </div>
          )}
        </aside>

        {/* MAIN PANEL AREA */}
        <main className="flex-1 p-8 lg:p-10 flex flex-col gap-6 bg-white overflow-hidden">
          {activeMode === 'transformer' ? (
            <>
              <div className="flex justify-between items-baseline">
                <h2 className="text-2xl font-black tracking-[-1px] uppercase">
                  Xem Trước Nội Dung SRT
                </h2>
                <span className="text-[12px] opacity-60 font-bold uppercase tracking-tight">
                  {chapters.length > 0 ? chapters[chapters.length - 1].title : "Đang chờ dữ liệu..."}
                </span>
              </div>

              <div className="flex-1 art-border bg-white overflow-y-auto overflow-x-hidden relative">
                {srtData.length === 0 ? (
                  <div className="absolute inset-0 flex flex-col items-center justify-center text-[#8E8680] gap-4 p-8 text-center">
                    <div className="w-16 h-16 border-2 border-dashed border-[#8E8680] rounded-full flex items-center justify-center animate-pulse">
                      <TableIcon size={24} />
                    </div>
                    <div>
                      <p className="font-black uppercase text-sm mb-1 tracking-widest text-art-ink">Chưa có kết quả</p>
                      <p className="text-[11px] font-bold">Thu thập dữ liệu và bắt đầu chuyển hóa để xem bản xem trước</p>
                    </div>
                  </div>
                ) : (
                  <table className="w-full text-left border-collapse font-art-mono text-[13px]">
                    <thead className="sticky top-0 z-10">
                      <tr className="bg-art-ink text-white">
                        <th className="p-4 font-black uppercase text-[11px] tracking-widest" width="60">ID</th>
                        <th className="p-4 font-black uppercase text-[11px] tracking-widest" width="180">Thời Gian</th>
                        <th className="p-4 font-black uppercase text-[11px] tracking-widest">Nội Dung (Đã Biến Đổi)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#eee]">
                      {srtData.map((entry) => (
                        <tr key={entry.index} className="even:bg-[#fdfdfd] hover:bg-art-bg/30 transition-colors">
                          <td className="p-4 font-bold text-art-ink/50">{entry.index}</td>
                          <td className="p-4 font-medium">
                            <span className="bg-art-bg px-2 py-0.5 border border-art-ink/10">
                              {entry.startTime}
                            </span>
                          </td>
                          <td className="p-4 leading-relaxed font-bold">
                            {entry.text}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                
                {/* Loading / Processing Overlay */}
                <AnimatePresence>
                  {(isScraping || isProcessingAI) && (
                    <motion.div 
                      key="main-overlay"
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 bg-art-bg/95 backdrop-blur-[6px] flex items-center justify-center z-[100] p-8"
                    >
                      <div className="max-w-sm w-full art-border bg-white p-8 text-center space-y-6 shadow-[12px_12px_0_0_#1a1a1a]">
                        <div className="relative inline-block">
                          <div className="w-20 h-20 border-4 border-art-ink border-t-art-accent rounded-full animate-spin"></div>
                          <div className="absolute inset-0 flex items-center justify-center">
                            <Loader2 className="animate-pulse text-art-ink" size={24} />
                          </div>
                        </div>
                        
                        <div className="space-y-3">
                          <p className="text-[11px] font-black uppercase tracking-[4px] text-art-ink">
                            {isScraping ? "Hệ thống đang quét" : "AI ĐANG CHUYỂN HÓA"}
                          </p>
                          <div className="bg-art-bg p-3 border-2 border-art-ink/5">
                            <p className="text-[10px] font-bold text-art-ink leading-relaxed italic">
                              "{progress.message}"
                            </p>
                          </div>
                        </div>

                        <div className="h-2 bg-[#f1f1f1] w-full relative overflow-hidden border border-art-ink/10">
                          <motion.div 
                            className="absolute inset-y-0 left-0 bg-art-accent"
                            animate={{ 
                              width: ["0%", "100%", "0%"],
                              x: ["-100%", "100%", "-100%"]
                            }}
                            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                          />
                        </div>

                        <p className="text-[9px] font-bold text-[#8E8680] uppercase">
                          Vui lòng không đóng tab này
                        </p>

                        <button 
                          onClick={cancelProcessing}
                          className="art-btn !bg-white !text-art-ink w-full py-4 border-2 border-art-ink hover:!bg-red-600 hover:!text-white hover:!border-red-600 transition-all group"
                        >
                          <XCircle size={18} className="group-hover:scale-110 transition-transform" />
                          Dừng lại (Hủy bỏ)
                        </button>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            </>
          ) : (
            <>
              <div className="flex justify-between items-baseline">
                <h2 className="text-2xl font-black tracking-[-1px] uppercase">
                  Kết Quả Chia Nhỏ SRT
                </h2>
                <span className="text-[12px] opacity-60 font-bold uppercase tracking-tight">
                  {uploadedFileName || "Chưa có file"}
                </span>
              </div>

              <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-6 overflow-y-auto pr-2">
                {splitResults.length === 0 ? (
                    <div className="col-span-full border-2 border-dashed border-art-ink/10 flex flex-col items-center justify-center p-20 text-[#8E8680]">
                      <Scissors size={48} className="mb-4 opacity-20" />
                      <p className="font-black uppercase text-sm tracking-widest text-art-ink">Sẵn sàng thu nhỏ</p>
                      <p className="text-[11px] font-bold mt-2">Kéo thả hoặc tải file SRT lên để bắt đầu chia nhỏ</p>
                    </div>
                ) : (
                  splitResults.map((blocks, idx) => (
                    <div key={idx} className="flex flex-col art-border bg-[#fafafa] shadow-[6px_6px_0_0_#1a1a1a]">
                      <div className="p-4 border-b border-art-ink/10 flex justify-between items-center bg-white">
                        <span className="text-[11px] font-black uppercase tracking-widest flex items-center gap-2 text-art-accent">
                          <Files size={14} /> Part {idx + 1}
                        </span>
                        <button 
                          onClick={() => downloadSplitPart(idx)}
                          className="text-[10px] font-black uppercase hover:text-art-accent flex items-center gap-1"
                        >
                          Tải xuống <Download size={12} />
                        </button>
                      </div>
                      <div className="flex-1 p-4 overflow-y-auto bg-[#f0f0f0]">
                        <div className="bg-white p-4 border border-art-ink/5 shadow-sm min-h-full">
                          <pre className="text-[11px] leading-relaxed font-art-mono text-art-ink whitespace-pre-wrap break-words">
                            {blocks.slice(0, 5).join("\n\n")}
                            {blocks.length > 5 && "\n\n... (và còn tiếp)"}
                          </pre>
                        </div>
                      </div>
                      <div className="p-3 border-t border-art-ink/10 bg-white/80 text-[9px] font-black uppercase tracking-tighter flex justify-between">
                         <span>Tổng cộng: {blocks.length} phân đoạn</span>
                         <span>ID: {blocks[0].match(/^\d+/)?.[0]} - {blocks[blocks.length-1].match(/^\d+/)?.[0]}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </>
          )}
        </main>
      </div>

      {/* STATUS BAR FOOTER */}
      <footer className="border-t-2 border-art-ink p-4 px-8 lg:px-10 flex justify-between bg-art-bg text-[11px] font-black uppercase tracking-wider">
        <div className="flex gap-8">
          <span>TỔNG SỐ CHƯƠNG: <span className="text-art-accent">{chapters.length}</span></span>
          <span className="flex items-center gap-2">
            ĐÃ XỬ LÝ: <span className={progress.current > 0 ? "text-art-accent" : ""}>{progress.current}</span>
          </span>
          <span className="text-art-ink/40">Status: {progress.message}</span>
        </div>
        <div className="flex gap-8">
          <span>THỜI LƯỢNG ƯỚC TÍNH: <span className="text-art-accent">{(srtData.length * 0.1).toFixed(1)} MIN</span></span>
          <span>PHIÊN BẢN: v2.4.0-ART</span>
        </div>
      </footer>

      <style>{`
        ::-webkit-scrollbar {
          width: 8px;
        }
        ::-webkit-scrollbar-track {
          background: #f1f1f1;
        }
        ::-webkit-scrollbar-thumb {
          background: #1a1a1a;
          border: 2px solid #f1f1f1;
        }
        ::-webkit-scrollbar-thumb:hover {
          background: #ff4d00;
        }
      `}</style>
    </div>
  );
}
