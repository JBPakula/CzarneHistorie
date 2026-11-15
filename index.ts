import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Pobiera listę wszystkich kluczy API z sekretów GEMINI_API_KEYS oraz GEMINI_API_KEY
function getAllApiKeys(): string[] {
  const multiKeys = Deno.env.get("GEMINI_API_KEYS") || "";
  const singleKey = Deno.env.get("GEMINI_API_KEY") || "";

  const combined = [
    ...multiKeys.split(","),
    ...singleKey.split(","),
  ]
    .map((k) => k.trim())
    .filter((k) => k.length > 0);

  return Array.from(new Set(combined));
}

// Pobiera posortowaną listę aktywnych modeli Gemini/Gemma dla danego klucza
async function getCandidateModels(apiKey: string): Promise<string[]> {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`
  );
  if (!res.ok) {
    return [];
  }
  const data = await res.json();
  const models: any[] = data.models || [];

  const validModels = models.filter(
    (m) =>
      Array.isArray(m.supportedGenerationMethods) &&
      m.supportedGenerationMethods.includes("generateContent") &&
      (m.name.includes("gemini") || m.name.includes("gemma-3")) &&
      !m.name.includes("embedding") &&
      !m.name.includes("image") &&
      !m.name.includes("tts") &&
      !m.name.includes("aqa")
  );

  const scored = validModels.map((m) => {
    const name: string = m.name;
    let score = 0;
    if (name.includes("gemini-3") && name.includes("flash")) score = 100;
    else if (name.includes("flash-lite")) score = 90;
    else if (name.includes("flash-latest") || name.includes("gemini-2.5-flash")) score = 85;
    else if (name.includes("flash")) score = 80;
    else if (name.includes("pro")) score = 70;
    else if (name.includes("gemma-3-27b")) score = 60;
    else score = 50;
    return { name, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.name);
}

// Iteruje po modelach oraz po całej puli kluczy API ze wspólnej puli
async function callGeminiWithKeyPool(
  apiKeys: string[],
  promptText: string,
  temperature: number,
  expectJson: boolean
): Promise<string> {
  let candidateModels: string[] = [];
  for (const key of apiKeys) {
    candidateModels = await getCandidateModels(key);
    if (candidateModels.length > 0) break;
  }

  if (candidateModels.length === 0) {
    throw new Error("Żaden z kluczy API nie zwrócił listy dostępnych modeli w Google AI Studio.");
  }

  const shuffledKeys = [...apiKeys].sort(() => Math.random() - 0.5);
  let lastError = "Brak odpowiedzi z modeli.";

  for (const modelPath of candidateModels) {
    const isGemma = modelPath.includes("gemma");
    const generationConfig: Record<string, unknown> = { temperature };
    if (expectJson && !isGemma) {
      generationConfig.responseMimeType = "application/json";
    }

    for (const apiKey of shuffledKeys) {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/${modelPath}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: promptText }] }],
            generationConfig,
          }),
        }
      );

      if (res.ok) {
        const data = await res.json();
        const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text?.trim();
        if (rawText) {
          return rawText;
        }
      } else {
        const errText = await res.text();
        lastError = `(${res.status}) dla ${modelPath}: ${errText}`;
        if (res.status === 429 || res.status === 404 || res.status === 400 || res.status === 403) {
          continue;
        }
        throw new Error(`Błąd Gemini API ${lastError}`);
      }
    }
  }

  throw new Error(`Wszystkie klucze i modele we wspólnej puli osiągnęły dzienny limit zapytań. Ostatni błąd: ${lastError}`);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const apiKeys = getAllApiKeys();
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (apiKeys.length === 0) {
      throw new Error("Brak skonfigurowanych sekretów GEMINI_API_KEYS lub GEMINI_API_KEY w Supabase.");
    }

    const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const payload = await req.json();
    const { action } = payload;

    // ========================================================================
    // TRYB 1: TWORZENIE NOWEJ HISTORII (BLACK STORY vs CRIME INVESTIGATION)
    // ========================================================================
    if (action === "create_story") {
      const { theme, created_by, game_mode } = payload;
      const mode = game_mode === "crime_investigation" ? "crime_investigation" : "black_story";

      const safetyConstraint = `BEZWZGLĘDNA ZASADA BEZPIECZEŃSTWA FABULARNEGO:
- Zagadka ani akta sprawy NIE MOGĄ w żaden sposób dotyczyć dzieci, niemowląt, nastolatków ani jakichkolwiek osób niepełnoletnich (poniżej 18. roku życia).
- Wszystkie postacie występujące w historii (ofiary, sprawcy, świadkowie, osoby wspominane w tle lub w motywach) muszą być wyłącznie osobami pełnoletnimi (dorosłymi, 25+ lat).`;

      let systemPrompt = "";

      if (mode === "crime_investigation") {
        const themeInstruction = theme
          ? `Motyw przewodni / sceneria narzucona przez graczy: "${theme}".`
          : "Wymyśl wciągającą, realistyczną i wielowątkową sprawę kryminalną z wyrazistymi dorosłymi bohaterami (np. mała społeczność, zamknięty ośrodek, firma rodzinna, pensjonat lub kamienica).";

        systemPrompt = `Jesteś Mistrzem Gry i scenarzystą interaktywnego śledztwa kryminalnego (RPG detektywistyczne w stylu kryminału noir / proceduralnego).
${themeInstruction}

${safetyConstraint}

Zasady tworzenia śledztwa:
1. Stwórz kompletną, spójną intrygę kryminalną z wyrazistym sprawcą, motywem, fałszywymi tropami (red herrings), alibi poszczególnych osób oraz fizycznymi poszlakami.
2. Zadbaj o pełnokrwiste postacie (świadków, podejrzanych, techników), z których każda ma swój unikalny sposób mówienia, sekret i nastawienie do detektywów.
3. Zwróć odpowiedź WYŁĄCZNIE jako czysty obiekt JSON (bez znaczników markdown \`\`\`json) o dokładnie takiej strukturze:
{
  "title": "Krótki, intrygujący tytuł sprawy (max 6 słów)",
  "public_intro": "Rozbudowane AKTA SPRAWY NA START (3-4 krótkie akapity): 1) Opis miejsca zdarzenia i okoliczności wezwania; 2) Wstępne ustalenia techników i zabezpieczone ślady; 3) Lista 3-4 kluczowych osób powiązanych ze sprawą (imię, wiek dorosły, rola, pierwsze wrażenie), które gracze mogą przesłuchać lub sprawdzić.",
  "secret_truth": "KOMPLETNA KARTA PRAWDY DLA MISTRZA GRY: kto jest sprawcą i dlaczego, dokładny przebieg zbrodni minuta po minucie, jakie kłamstwa mówią poszczególni świadkowie, co ukrywa każda z postaci (nawet osoby niewinne), jakie dowody obciążają sprawcę oraz jak postacie reagują na konkretne pytania i konfrontacje."
}`;
      } else {
        const themeInstruction = theme
          ? `Motyw przewodni / klimat narzucony przez gracza: "${theme}".`
          : "Wymyśl oryginalny, zaskakujący i nieoczywisty motyw kryminalny lub obyczajowy w stylu klasycznych Czarnych Historii.";

        systemPrompt = `Jesteś Mistrzem Gry tworzącym mroczne, logiczne zagadki detektywistyczne w stylu gry "Czarne Historie".
${themeInstruction}

${safetyConstraint}

Zasady tworzenia zagadki:
1. Zagadka musi być w 100% logiczna, spójna i rozwiązywalna poprzez zadawanie pytań zamkniętych (tak/nie) lub szczegółowych.
2. Musisz wymyślić kompletną, zamkniętą historię PRZED rozpoczęciem gry, aby każdy detal był z góry ustalony.
3. Zwróć odpowiedź WYŁĄCZNIE jako czysty obiekt JSON (bez znaczników markdown \`\`\`json) o dokładnie takiej strukturze:
{
  "title": "Krótki, intrygujący tytuł sprawy (max 6 słów)",
  "public_intro": "Tajemniczy opis sytuacji wyjściowej, który widzą gracze na start (2-4 zdania, opisuje dziwny finał lub zastaną scenę bez zdradzania przyczyny).",
  "secret_truth": "Kompletna, szczegółowa karta prawdy dla Mistrza Gry: kto, co, kiedy, gdzie, dlaczego, dokładny przebieg wydarzeń krok po kroku, motywy, alibi oraz kluczowe fakty potrzebne do odpowiadania na dowolne pytania graczy."
}`;
      }

      const rawText = await callGeminiWithKeyPool(
        apiKeys,
        systemPrompt,
        mode === "crime_investigation" ? 0.9 : 0.85,
        true
      );

      const cleanedJson = rawText.replace(/^```json\s*/i, "").replace(/```\s*$/i, "").trim();
      const parsed = JSON.parse(cleanedJson);

      const { data: insertedStory, error: dbError } = await supabaseAdmin
        .from("ch_stories")
        .insert({
          title: parsed.title,
          public_intro: parsed.public_intro,
          secret_truth: parsed.secret_truth,
          created_by: created_by || null,
          game_mode: mode,
        })
        .select("id, title, public_intro, created_by, created_at, game_mode")
        .single();

      if (dbError) throw dbError;

      return new Response(JSON.stringify({ story: insertedStory }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ========================================================================
    // TRYB 2: ZADANIE PYTANIA / RUCH W ŚLEDZTWIE (DOPASOWANY DO TRYBU GRY)
    // ========================================================================
    if (action === "ask_question") {
      const { story_id, parent_node_id, author_id, question_text, visibility } = payload;

      const { data: story, error: storyErr } = await supabaseAdmin
        .from("ch_stories")
        .select("title, public_intro, secret_truth, game_mode")
        .eq("id", story_id)
        .single();

      if (storyErr || !story) throw new Error("Nie znaleziono sprawy w bazie.");

      const mode = story.game_mode === "crime_investigation" ? "crime_investigation" : "black_story";

      const { data: allNodes } = await supabaseAdmin
        .from("ch_nodes")
        .select("id, parent_node_id, question_text, ai_answer_text")
        .eq("story_id", story_id)
        .order("created_at", { ascending: true });

      const branchHistory: string[] = [];
      if (allNodes && allNodes.length > 0) {
        if (mode === "crime_investigation" || !parent_node_id) {
          // W śledztwie kryminalnym historia jest liniowa – bierzemy wszystkie dotychczasowe kroki
          allNodes.forEach((n) => {
            branchHistory.push(`Detektyw: ${n.question_text}\nNarracja / Postacie: ${n.ai_answer_text}`);
          });
        } else {
          // W klasycznej Czarnej Historii odtwarzamy ścieżkę aktywnej gałęzi (Git-branch)
          const nodesMap = new Map(allNodes.map((n) => [n.id, n]));
          let currId: string | null = parent_node_id;
          const chain = [];
          while (currId && nodesMap.has(currId)) {
            const n = nodesMap.get(currId)!;
            chain.unshift(`Gracz: ${n.question_text}\nMistrz Gry: ${n.ai_answer_text}`);
            currId = n.parent_node_id;
          }
          branchHistory.push(...chain);
        }
      }

      const historyBlock =
        branchHistory.length > 0
          ? `Dotychczasowy przebieg śledztwa:\n${branchHistory.join("\n---\n")}`
          : "To jest pierwszy ruch / pierwsze pytanie w tym śledztwie.";

      let answerPrompt = "";

      if (mode === "crime_investigation") {
        answerPrompt = `Jesteś Mistrzem Gry i narratorem w interaktywnym śledztwie kryminalnym. Prowadzisz rozgrywkę z perspektywy scenicznej (dialogi postaci, opisy zachowań, wyniki ekspertyz, odkrywane poszlaki), opierając się ściśle na KARCIE PRAWDY.

TYTUŁ AKT SPRAWY: ${story.title}
AKTA STARTOWE (znane graczom):
${story.public_intro}

TAJNA KARTA PRAWDY (znana TYLKO Tobie – trzymaj się jej faktów i psychologii postaci):
${story.secret_truth}

${historyBlock}

AKTUALNY RUCH / PYTANIE DETEKTYWA: "${question_text}"

Zasady Twojej odpowiedzi:
- NIE odpowiadaj zdawkowo „Tak” lub „Nie”. Odpowiadaj fabularnie (2–4 krótkie akapity): opisz reakcję postaci, przytocz jej bezpośrednią wypowiedź (z charakterem, emocjami, wahaniem lub ironią) albo przedstaw wynik oględzin/sprawdzenia tropu.
- Postacie mogą kręcić, ukrywać niewygodne dla siebie sekrety niezwiązane ze zbrodnią lub bronić swojego alibi zgodnie z Kartą Prawdy, ale nie mogą wymyślać faktów sprzecznych z prawdą.
- Jeśli gracz przyciśnie świadka konkretnym dowodem lub sprzecznością, postać powinna zareagować adekwatnie (zmieszać się, zmienić wersję, ujawnić nowy trop).
- Jeśli gracz sformułował pełne oskarżenie i poprawnie wskazał sprawcę, motyw oraz sposób działania, odegraj finałową scenę konfrontacji/zatrzymania i pogratuluj rozwiązania sprawy.`;
      } else {
        answerPrompt = `Jesteś Mistrzem Gry w grze "Czarne Historie". Odpowiadasz na pytanie gracza wyłącznie na podstawie poniższej KARTY PRAWDY.

TYTUŁ SPRAWY: ${story.title}
OPIS STARTOWY (znany graczom): ${story.public_intro}

TAJNA KARTA PRAWDY (znana TYLKO Tobie – nie zdradzaj jej w całości, chyba że gracz trafił w sedno rozwiązania):
${story.secret_truth}

${historyBlock}

NOWE PYTANIE GRACZA: "${question_text}"

Zasady Twojej odpowiedzi:
- Odpowiadaj po polsku, zwięźle i klimatycznie.
- Jeśli pytanie pozwala odpowiedzieć "Tak", "Nie", "Nie ma to znaczenia" lub "Częściowo / Dopytaj precyzyjniej", zacznij od tego werdyktu, a następnie dodaj maksymalnie 1 krótkie zdanie doprecyzowania, jeśli jest to zgodne z Kartą Prawdy i nie psuje zabawy.
- Nigdy nie zmieniaj faktów z Karty Prawdy i nie dopisuj nowej fabuły.
- Jeśli gracz opisał pełne, poprawne rozwiązanie zagadki, pogratuluj mu i potwierdź rozwiązanie sprawy.`;
      }

      const aiAnswer = await callGeminiWithKeyPool(
        apiKeys,
        answerPrompt,
        mode === "crime_investigation" ? 0.65 : 0.3,
        false
      );

      const { data: insertedNode, error: insertErr } = await supabaseAdmin
        .from("ch_nodes")
        .insert({
          story_id,
          parent_node_id: mode === "crime_investigation" ? null : (parent_node_id || null),
          author_id,
          question_text,
          ai_answer_text: aiAnswer,
          visibility: mode === "crime_investigation" ? "public" : (visibility || "public"),
        })
        .select("*")
        .single();

      if (insertErr) throw insertErr;

      return new Response(JSON.stringify({ node: insertedNode }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    throw new Error(`Nieznana akcja: ${action}`);
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});