import { FormEvent, useEffect, useMemo, useState } from "react";

import { BACKEND_HTTP_URL } from "../shared/config";

interface MemoryItem {
  title: string;
  excerpt: string;
  score?: number | null;
  kind?: string;
  source_url?: string | null;
}

interface MemoryResponse {
  answer?: string;
  memories?: MemoryItem[];
  containerTag?: string;
}

type SearchScope = "current" | "all";

export default function MemoriesTab() {
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");
  const [activeTabUrl, setActiveTabUrl] = useState<string | null>(null);
  const [scopeLabel, setScopeLabel] = useState("interpreter-sessions");
  const [searchScope, setSearchScope] = useState<SearchScope>("current");
  const [currentScopeLabel, setCurrentScopeLabel] = useState("interpreter-sessions");
  const [currentScopeButtonLabel, setCurrentScopeButtonLabel] = useState("Current graph");

  const placeholder = useMemo(() => (
    answer || "Ask about people, topics, decisions, or anything Distill has already captured."
  ), [answer]);

  useEffect(() => {
    const loadActiveTab = async () => {
      try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tabs[0]?.url || null;
        setActiveTabUrl(url);

        if (!url) {
          setCurrentScopeLabel("interpreter-sessions");
          setScopeLabel("interpreter-sessions");
          return;
        }

        const parsed = new URL(url);
        const isYoutubeWatch = parsed.hostname.endsWith("youtube.com") && parsed.pathname === "/watch";
        const videoId = parsed.searchParams.get("v")?.trim();
        const nextScopeLabel = isYoutubeWatch && videoId ? videoId : "interpreter-sessions";
        setCurrentScopeLabel(nextScopeLabel);
        setCurrentScopeButtonLabel(isYoutubeWatch && videoId ? "This video" : "Current graph");
        setScopeLabel(nextScopeLabel);
      } catch {
        setActiveTabUrl(null);
        setCurrentScopeLabel("interpreter-sessions");
        setCurrentScopeButtonLabel("Current graph");
        setScopeLabel("interpreter-sessions");
      }
    };

    void loadActiveTab();
  }, []);

  useEffect(() => {
    setScopeLabel(searchScope === "all" ? "all memories" : currentScopeLabel);
  }, [currentScopeLabel, searchScope]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const trimmedQuery = query.trim();
    if (!trimmedQuery || isLoading) {
      return;
    }

    setIsLoading(true);
    setError("");

    try {
      const response = await fetch(`${BACKEND_HTTP_URL}/api/memories/query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: trimmedQuery,
          limit: 5,
          scope: searchScope,
          ...(activeTabUrl ? { tab_url: activeTabUrl } : {}),
        }),
      });

      const data = (await response.json()) as MemoryResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error || "Could not query memories.");
      }

      setAnswer(data.answer?.trim() || "I found a few related memories.");
      setMemories(Array.isArray(data.memories) ? data.memories : []);
      setScopeLabel(data.containerTag || "all memories");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Could not query memories.";
      setError(message);
      setAnswer("");
      setMemories([]);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="memories-tab">
      <div className="memory-section">
        <div className="section-label">Ask Distill</div>
        <div className="memory-scope-switch" role="tablist" aria-label="Memory search scope">
          <button
            className={`memory-scope-btn ${searchScope === "current" ? "active" : ""}`}
            type="button"
            onClick={() => setSearchScope("current")}
            role="tab"
            aria-selected={searchScope === "current"}
          >
            {currentScopeButtonLabel}
          </button>
          <button
            className={`memory-scope-btn ${searchScope === "all" ? "active" : ""}`}
            type="button"
            onClick={() => setSearchScope("all")}
            role="tab"
            aria-selected={searchScope === "all"}
          >
            All memories
          </button>
        </div>
        <div className="memory-scope">
          Searching in <code>{scopeLabel}</code>
        </div>
        <form className="memory-form" onSubmit={handleSubmit}>
          <textarea
            className="memory-input"
            rows={3}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="What do we remember about this topic?"
          />
          <button
            className="memory-submit"
            type="submit"
            disabled={isLoading || !query.trim()}
          >
            {isLoading ? "Searching..." : "Ask Distill"}
          </button>
        </form>
      </div>

      <div className="memory-section">
        <div className="section-label">Answer</div>
        <div className={`memory-answer ${answer ? "filled" : ""}`}>
          {error ? <span className="memory-error">{error}</span> : placeholder}
        </div>
      </div>

      <div className="memory-section">
        <div className="section-label">Top Memories</div>
        <div className="memory-results">
          {memories.length === 0 ? (
            <div className="memory-empty">
              {isLoading ? "Looking through saved memories..." : "Your most relevant memory matches will show up here."}
            </div>
          ) : (
            memories.map((memory, index) => (
              <article key={`${memory.title}-${index}`} className="memory-card">
                <div className="memory-card-header">
                  <span className="memory-card-title">{memory.title || "Memory"}</span>
                  {typeof memory.score === "number" && (
                    <span className="memory-card-score">{Math.round(memory.score * 100)}%</span>
                  )}
                </div>
                <p className="memory-card-excerpt">{memory.excerpt}</p>
                {memory.source_url && (
                  <a
                    className="memory-card-link"
                    href={memory.source_url}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open source
                  </a>
                )}
              </article>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
