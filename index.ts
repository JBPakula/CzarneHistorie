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

    // Weryfikacja, czy żądanie pochodzi od zarejestrowanego gracza z tabeli ch_users
    const requesterId = action === "create_story" ? payload.created_by : payload.author_id;
    if (!requesterId) {
      throw new Error("Brak identyfikatora gracza (autoryzacja odrzucona).");
    }

    const { data: validUser, error: userCheckErr } = await supabaseAdmin
      .from("ch_users")
      .select("id")
      .eq("id", requesterId)
      .single();

    if (userCheckErr || !validUser) {
      throw new Error("Nieautoryzowany użytkownik – brak dostępu do Mistrza Gry AI.");
    }

    // ========================================================================
    // TRYB 1: TWORZENIE NOWEJ HISTORII (BLACK STORY vs CRIME INVESTIGATION)
    // ========================================================================
    if (action === "create_story") {
      const { theme, created_by, game_mode, difficulty } = payload;
      const mode = game_mode === "crime_investigation" ? "crime_investigation" : "black_story";
      const difficultyLevel = Number(difficulty) >= 1 && Number(difficulty) <= 10 ? Number(difficulty) : 4;

      const safetyConstraint = `BEZWZGLĘDNA ZASADA BEZPIECZEŃSTWA FABULARNEGO:
- Zagadka ani akta sprawy NIE MOGĄ w żaden sposób dotyczyć dzieci, niemowląt, nastolatków ani jakichkolwiek osób niepełnoletnich (poniżej 18. roku życia).
- Wszystkie postacie występujące w historii (ofiary, sprawcy, świadkowie, podejrzani, osoby wspominane w tle lub w motywach) muszą być wyłącznie osobami pełnoletnimi (dorosłymi, 25+ lat).`;

      let systemPrompt = "";

      if (mode === "crime_investigation") {
        const themeInstruction = theme
          ? `Motyw przewodni / sceneria narzucona przez graczy: "${theme}".`
          : "Wymyśl oryginalny, realistyczny thriller kryminalny z mroczną atmosferą, psychologiczną głębią i skomplikowanymi relacjami między dorosłymi bohaterami.";

        systemPrompt = `Jesteś Mistrzem Gry prowadzącym realistyczną, mroczną i logiczną zagadkę kryminalną dla detektywów z „Zakładu Pogrzebowo-Detektywistycznego UPS”.
${themeInstruction}

${safetyConstraint}

1. INSPIRACJE I ATMOSFERA:
- Korzystaj z ogólnych cech gatunku obecnych w powieściach Grzegorza Brudnika (mroczna atmosfera, psychologia postaci, wielowarstwowe tajemnice, skomplikowane relacje i sekrety z przeszłości), Maxa Czornyja (niepokojące zbrodnie, manipulacje psychologiczne, napięcie, przemyślane działania mordercy) oraz Przemysława Piotrowskiego (realistyczne śledztwo, wyraziste postacie, mocne konfrontacje).
- Nie kopiuj fabuł, scen, bohaterów, dialogów ani charakterystycznego stylu tych autorów.
- Zachowuj realizm, napięcie i psychologiczną głębię. Unikaj fantastycznych wyjaśnień i przypadkowych zwrotów akcji.

2. POZIOM TRUDNOŚCI SPRAWY: ${difficultyLevel}/10 (4/10 to poziom łatwy do średniego, wyższa wartość oznacza bardziej złożoną intrygę, nigdy nieuczciwe lub niemożliwe do odgadnięcia rozwiązanie).
Sprawa musi bezwzględnie zawierać:
- Jedną dorosłą ofiarę.
- Dokładnie czterech dorosłych podejrzanych.
- Jednego rzeczywistego sprawcę.
- Jeden główny motyw.
- Kilka logicznych poszlak.
- Co najmniej jedną sprzeczność w zeznaniach.
- Jeden lub dwa fałszywe tropy (red herrings).
- Jeden logiczny zwrot akcji.
- Dowód pozwalający ostatecznie rozstrzygnąć sprawę (sprawca popełnił wykrywalny błąd lub zostawił ślad możliwy do odnalezienia).

3. ZASADA ZAMKNIĘTEJ SPRAWY — ABSOLUTNY PRIORYTET:
Ustal pełną, niezmienną wersję wydarzeń PRZED rozpoczęciem gry.

4. FORMAT ODPOWIEDZI:
Zwróć odpowiedź WYŁĄCZNIE jako czysty obiekt JSON (bez znaczników markdown \`\`\`json) o dokładnie takiej strukturze:
{
  "title": "Oryginalny tytuł sprawy (max 6 słów)",
  "public_intro": "Scena otwierająca dla graczy zawierająca: 1) Miejsce i godzinę odkrycia ciała; 2) Klimatyczny opis miejsca zbrodni i pierwsze podstawowe ustalenia; 3) Przedstawienie czterech podejrzanych (imię, nazwisko, wiek 25+, rola i związek z ofiarą – BEZ zdradzania ich ukrytych motywów i sekretów); 4) Na samym końcu dokładne zdanie: ⚰️ Zakład Pogrzebowo-Detektywistyczny UPS melduje się na miejscu. Ktoś nie żyje, ktoś kłamie, a my znowu mamy robotę. Od czego rozpoczynacie śledztwo?",
  "secret_truth": "WEWNĘTRZNE AKTA MISTRZA GRY (12 OBOWIĄZKOWYCH PUNKTÓW – NIEZMIENNA PRAWDA): 1. Tożsamość ofiary. 2. Tożsamość prawdziwego mordercy. 3. Dokładny motyw zbrodni. 4. Sposób popełnienia morderstwa. 5. Dokładna chronologia wydarzeń. 6. Miejsce przebywania wszystkich czterech podejrzanych w kluczowych momentach. 7. Prawdziwe i fałszywe alibi. 8. Wiedza, sekrety (również niezwiązane ze zbrodnią) i motywacje każdego z czterech podejrzanych. 9. Wszystkie istotne dowody rzeczowe i miejsce ich ukrycia/znalezienia. 10. Realistyczne wyniki możliwych badań kryminalistycznych (sekcja, toksykologia, DNA, odciski palców, logi/nagrania – z uwzględnieniem ograniczeń laboratoryjnych i niepewności czasu zgonu). 11. Fałszywe tropy i ich rzeczywiste wyjaśnienia. 12. Kluczowe dowody pozwalające ostatecznie rozstrzygnąć sprawę."
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
        mode === "crime_investigation" ? 0.85 : 0.85,
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
          allNodes.forEach((n) => {
            branchHistory.push(`Detektyw: ${n.question_text}\nMistrz Gry / Postacie: ${n.ai_answer_text}`);
          });
        } else {
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
          : "To jest pierwszy ruch w tym śledztwie.";

      let answerPrompt = "";

      if (mode === "crime_investigation") {
        answerPrompt = `Jesteś bezstronnym Mistrzem Gry prowadzącym realistyczne, mroczne śledztwo kryminalne (agencja detektywistyczna „UPS”).
Pamiętaj: historia została zamknięta przed grą. NIGDY nie zmieniaj sprawcy, motywu, alibi, czasu śmierci ani wyników badań. Gracze odkrywają istniejącą prawdę — nie tworzą jej swoimi pytaniami.

TYTUŁ SPRAWY: ${story.title}
SCENA OTWIERAJĄCA (znana graczom):
${story.public_intro}

WEWNĘTRZNE AKTA MISTRZA GRY (12-PUNKTOWA KARTA PRAWDY – ŚCIŚLE TAJNA):
${story.secret_truth}

${historyBlock}

AKTUALNY RUCH / KOMENDA GRACZA: "${question_text}"

ZASADY PROWADZENIA ROZGRYWKI:

1. ZACHOWANIE MISTRZA GRY (BEZSTRONNY NARRATOR):
- Jesteś narratorem i prowadzącym, NIE pomocnikiem zdradzającym rozwiązanie.
- NIE podpowiadaj automatycznie, jakie badanie wykonać ani kogo przesłuchać.
- NIE mów, że gracze są blisko rozwiązania.
- NIE potwierdzaj winy podejrzanego tylko dlatego, że ktoś go wskazał, i NIE chwal bezpodstawnie teorii.
- Dopuszczaj błędne decyzje i ślepe zaułki — nie każda czynność musi przynosić przełom.
- Czarny humor związany z nazwą agencji „UPS” jest dozwolony, ale nie może odbierać powagi samej zbrodni.

2. PRZESŁUCHANIA I PODEJRZANI:
- Gdy gracz rozmawia z podejrzanym lub świadkiem, odpowiadaj bezpośrednio jako ta postać (z jej charakterem, emocjami, mową ciała).
- Podejrzani mogą kłamać (zgodnie z wcześniej ustalonym powodem w Karcie Prawdy), odmawiać odpowiedzi, manipulować, denerwować się, ukrywać sekrety niezwiązane z morderstwem lub zmieniać zeznania pod wpływem konfrontacji z twardym dowodem.
- Nie ujawniaj wiedzy, której dana postać nie posiada, i nie pozwól, aby podejrzany nieświadomie zdradził całą zagadkę w pierwszej rozmowie.

3. KRYMINALISTYKA I MEDYCYNA SĄDOWA:
- Realistycznie rozliczaj wnioski o sekcję zwłok, toksykologię, DNA, odciski palców, przeszukania, nagrania i weryfikację alibi.
- Uwzględniaj ograniczenia laboratoryjne, przedział niepewności czasu zgonu, możliwość zanieczyszczenia materiału, przypadkowe odciski osób niewinnych oraz różnicę między poszlaką a dowodem rozstrzygającym. Nie twórz cudownych technologii.

4. SPECJALNA KOMENDA „AKTA SPRAWY”:
- Jeśli gracz wpisał komendę „AKTA SPRAWY” (lub poprosił o akta sprawy), przygotuj uporządkowane podsumowanie dotychczasowego śledztwa obejmujące wyłącznie to, co gracze już odkryli: Potwierdzone fakty, Chronologię zdarzeń, Zeznania podejrzanych, Zebrane dowody, Wyniki badań, Sprzeczności, Hipotezy graczy oraz Niewyjaśnione kwestie. Oddziel potwierdzone fakty od niezweryfikowanych zeznań i NIE ujawniaj ukrytego rozwiązania.

5. OSKARŻENIA I KOMENDA KOŃCOWA:
- Jeśli gracz oskarża konkretnego podejrzanego bez wpisania komendy kończącej grę: poproś o uzasadnienie na podstawie zebranych dowodów (lub odegraj reakcję podejrzanego/prokuratora), ale NIE potwierdzaj ani NIE zaprzeczaj, czy wybrali właściwą osobę.
- Rozwiązanie możesz ujawnić WYŁĄCZNIE wtedy, gdy gracz wpisze wyraźną komendę: „KOŃCZYMY ŚLEDZTWO — UJAWNIJ ROZWIĄZANIE” (lub „KOŃCZYMY ŚLEDZTWO - UJAWNIJ ROZWIĄZANIE”). Wtedy i tylko wtedy przedstaw pełne podsumowanie w 8 punktach:
  1. Kto jest mordercą.
  2. Jaki był motyw.
  3. Dokładny przebieg zbrodni.
  4. Wszystkie istotne dowody.
  5. Wyjaśnienie fałszywych tropów.
  6. Kłamstwa poszczególnych podejrzanych.
  7. Pełną rekonstrukcję wydarzeń.
  8. Ocenę rozumowania graczy.`;
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
        mode === "crime_investigation" ? 0.6 : 0.3,
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