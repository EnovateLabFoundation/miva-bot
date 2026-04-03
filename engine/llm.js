const axios = require('axios');
require('dotenv').config();

class LLMEngine {
  constructor() {
    this.endpoint = process.env.OLLAMA_ENDPOINT || 'http://localhost:11434/api/generate';
    this.model = process.env.OLLAMA_MODEL || 'llama3';
  }

  async generate(prompt, systemPrompt = '') {
    try {
      const response = await axios.post(this.endpoint, {
        model: this.model,
        prompt: prompt,
        system: systemPrompt,
        stream: false,
      });

      return response.data.response;
    } catch (error) {
      console.error('Ollama Gen Error:', error.message);
      return null;
    }
  }

  async solveQuiz(questions) {
    const systemPrompt = `You are an expert academic assistant for Miva Open University. 
    Analyze the following quiz question(s) and provide the correct option(s). 
    Respond ONLY with a JSON object format: {"answers": [{"questionIndex": 0, "selection": "Option A"}]}`;
    
    const prompt = JSON.stringify(questions);
    const response = await this.generate(prompt, systemPrompt);
    
    try {
      // Clean the response in case LLM adds markdown or fluff
      const cleaned = response.match(/\{.*\}/s)[0];
      return JSON.parse(cleaned);
    } catch (e) {
      console.error('Failed to parse LLM response as JSON:', response);
      return null;
    }
  }

  async makeDecision(currentState) {
    const systemPrompt = `You are an autonomous browser agent for Miva Open University LMS. 
    Analyze the current page state and the list of interactive elements.
    Identify the "Next Activity", "Next Section", or the logical next step in the course curriculum.
    
    Current URL: ${currentState.url}
    Page Title: ${currentState.pageTitle}
    
    Interactive Elements (ID, Text):
    ${JSON.stringify(currentState.interactiveElements)}

    ACTIONS:
    - CLICK_NEXT: Index X (Choose the index of the link that represents the next activity/section)
    - SCROLL_DOWN (If the next button is likely further down)
    - MARK_DONE (If a "Mark Done" button is available and should be clicked)
    - WAIT (If the page is still loading)
    
    Respond in this format:
    ACTION: [Your Choice]
    REASON: [Short explanation]`;
    
    const prompt = `Page elements extracted. Identify the best action to continue the course progress.`;
    return await this.generate(prompt, systemPrompt);
  }
}

module.exports = new LLMEngine();
