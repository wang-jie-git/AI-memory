/**
 * query-optimizer: 查询优化器
 *
 * 用 LLM 将用户自然语言查询重写为更适合向量搜索的查询。
 * 参考架构: Agentic RAG 的 Query Optimization 模式
 *   - 原文: 用户问"盈利能力" → 优化为"净利润 毛利率 ROE 财务指标"
 *
 * 默认实现: LLMQueryOptimizer — 调用 OpenAI-compatible 文本生成 API
 * 兜底: NoopQueryOptimizer — 直接返回原查询
 */

// ===== Interface =====

export interface QueryOptimizer {
  /** 优化查询，返回更适合搜索的改写版本 */
  optimize(query: string): Promise<string>;
  readonly modelName: string;
}

// ===== Noop Fallback =====

export class NoopQueryOptimizer implements QueryOptimizer {
  readonly modelName = "noop";

  async optimize(query: string): Promise<string> {
    return query;
  }
}

// ===== LLM-based Query Optimizer =====

export interface LLMQueryOptimizerConfig {
  /** API base URL (OpenAI-compatible) */
  baseUrl?: string;
  /** API key */
  apiKey: string;
  /** Model name, default "gpt-4o-mini" */
  model?: string;
  /** Temperature, default 0 */
  temperature?: number;
  /** Max tokens for response, default 256 */
  maxTokens?: number;
  /** Optional: domain-specific optimization prompt */
  systemPrompt?: string;
}

export class LLMQueryOptimizer implements QueryOptimizer {
  readonly modelName: string;
  private config: Required<LLMQueryOptimizerConfig>;

  constructor(config: LLMQueryOptimizerConfig) {
    this.modelName = config.model ?? "gpt-4o-mini";
    this.config = {
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
      apiKey: config.apiKey,
      model: config.model ?? "gpt-4o-mini",
      temperature: config.temperature ?? 0,
      maxTokens: config.maxTokens ?? 256,
      systemPrompt: config.systemPrompt ?? DEFAULT_OPTIMIZER_PROMPT,
    };
  }

  async optimize(query: string): Promise<string> {
    const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages: [
          { role: "system", content: this.config.systemPrompt },
          { role: "user", content: query },
        ],
        temperature: this.config.temperature,
        max_tokens: this.config.maxTokens,
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Query optimizer API error: ${response.status} ${errText}`);
    }

    const data = (await response.json()) as {
      choices: Array<{ message: { content: string } }>;
    };

    const optimized = data.choices?.[0]?.message?.content?.trim();
    if (!optimized) {
      return query; // Fallback to original on empty response
    }

    return optimized;
  }
}

const DEFAULT_OPTIMIZER_PROMPT = `你是一个搜索查询优化专家。你的任务是将用户的问题改写为更适合语义搜索和向量检索的查询语句。

规则：
1. 提取核心概念，使用专业术语和同义词扩展
2. 移除口语化表达、语气词、无关修饰
3. 保持简洁，1-2句话即可
4. 保留关键实体名称（人名、产品名、技术术语）
5. 如果用户问题已经足够清晰，直接返回原问题
6. 只输出优化后的查询，不要解释

示例：
用户：帮我看看支付模块最近有什么问题
优化：支付模块 故障 异常 错误 问题排查

用户：那个熔断器的阈值是多少来着
优化：熔断器 阈值 配置 参数 熔断阈值

用户：怎么提高记忆系统的搜索准确率
优化：记忆系统 搜索 召回率 准确率 语义检索 优化

用户：${"{"}original_query}
优化：`;