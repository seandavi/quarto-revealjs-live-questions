--[[
live-poll.lua: turn `.poll` and `.wordcloud` divs into live-poll questions.

For revealjs output, each question div becomes

  <div id="ID" class="lp-question lp-poll" data-lp="{...Question, correct, results}">
    ...non-list content of the div (kept as-is)...
    <ul>...the original options, task-list markers stripped...</ul>
  </div>

and the resolved `live-poll:` config is written into
<script type="application/json" id="lp-config">. The deck plugin
(live-poll.js) does the rest. For any other format the div's list is kept
as a plain list. Limits mirror LIMITS in src/shared/protocol.ts.
]]

local LIMITS = {
  promptChars = 500,
  pollOptions = 26,
  optionChars = 200,
  maxWordsCeiling = 10,
  maxAnswersCeiling = 10,
  idMaxChars = 64,
  sessionMaxChars = 64,
}
local DEFAULTS = { maxWords = 3, maxAnswers = 3 }

local CHECKED = "\u{2612}"   -- ☒  Pandoc's task-list "[x]"
local UNCHECKED = "\u{2610}" -- ☐  Pandoc's task-list "[ ]"

local is_reveal = quarto.doc.is_format("revealjs")

local config = {
  server = nil,
  session = nil,
  closeOnLeave = true,
  results = "live",
  qr = true,
}
local seen_ids = {}
local last_heading = ""
local question_count = 0

local function warn(msg)
  quarto.log.warning("[live-poll] " .. msg)
end

local function ulen(s)
  return utf8.len(s) or #s
end

--- Cut a string to at most n UTF-8 characters.
local function utruncate(s, n)
  if ulen(s) <= n then return s end
  local stop = utf8.offset(s, n + 1)
  return stop and s:sub(1, stop - 1) or s
end

local function trim(s)
  return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function valid_session(s)
  return #s <= LIMITS.sessionMaxChars and s:match("^[A-Za-z0-9][A-Za-z0-9_-]*$") ~= nil
end

local function valid_id(s)
  return #s <= LIMITS.idMaxChars and s:match("^[A-Za-z0-9][A-Za-z0-9_:.-]*$") ~= nil
end

--- Session name from the input file stem, made to match LIMITS.sessionPattern.
local function default_session()
  local input = quarto.doc.input_file or (PANDOC_STATE.input_files or {})[1] or "deck"
  local stem = pandoc.path.split_extension(pandoc.path.filename(input))
  local s = stem:gsub("[^A-Za-z0-9_-]", "-"):gsub("%-%-+", "-"):gsub("^[^A-Za-z0-9]+", "")
  s = s:sub(1, LIMITS.sessionMaxChars):gsub("%-+$", "")
  if s == "" then s = "deck" end
  return s
end

local function meta_string(v)
  if v == nil then return nil end
  if type(v) == "boolean" then return tostring(v) end
  return trim(pandoc.utils.stringify(v))
end

local function meta_bool(v, default, key)
  if v == nil then return default end
  if type(v) == "boolean" then return v end
  local s = meta_string(v):lower()
  if s == "true" or s == "yes" then return true end
  if s == "false" or s == "no" then return false end
  warn(("live-poll.%s should be true or false, got %q; using %s"):format(key, s, tostring(default)))
  return default
end

local function results_mode(v, where)
  if v == "live" or v == "hidden" then return v end
  warn(("%s: results should be \"live\" or \"hidden\", got %q; using \"live\""):format(where, tostring(v)))
  return "live"
end

local function read_config(meta)
  local m = meta["live-poll"]
  if m ~= nil and type(m) ~= "table" then
    warn("`live-poll:` should be a map of options")
    m = nil
  end
  m = m or {}

  local server = meta_string(m.server)
  if server and server ~= "" then
    server = server:gsub("/+$", "")
    if not server:match("^https?://[^/]+$") then
      warn(("live-poll.server should be an origin like https://host[:port], got %q"):format(server))
    end
    config.server = server
  end

  local session = meta_string(m.session)
  if session == nil or session == "" then
    session = default_session()
  elseif not valid_session(session) then
    local fixed = default_session()
    warn(("live-poll.session %q must match [A-Za-z0-9][A-Za-z0-9_-]{0,63}; using %q"):format(session, fixed))
    session = fixed
  end
  config.session = session

  config.closeOnLeave = meta_bool(m["close-on-leave"], true, "close-on-leave")
  config.qr = meta_bool(m.qr, true, "qr")
  if m.results ~= nil then
    config.results = results_mode(meta_string(m.results), "live-poll")
  end
end

--- If a list item starts with a task-list marker, return (checked, item without it).
local function strip_marker(item)
  local first = item[1]
  if first == nil or (first.t ~= "Plain" and first.t ~= "Para") then return nil, item end
  local inl = first.content
  local head = inl[1]
  if head == nil or head.t ~= "Str" then return nil, item end
  local checked
  if head.text == CHECKED then checked = true
  elseif head.text == UNCHECKED then checked = false
  else return nil, item end
  local rest = pandoc.List()
  local start = 2
  if inl[2] and inl[2].t == "Space" then start = 3 end
  for i = start, #inl do rest:insert(inl[i]) end
  local copy = item:clone()
  copy[1] = first.t == "Plain" and pandoc.Plain(rest) or pandoc.Para(rest)
  return checked, copy
end

local function is_list(b)
  return b.t == "BulletList" or b.t == "OrderedList"
end

local function int_attr(attrs, name, default, ceiling, where)
  local raw = attrs[name]
  if raw == nil then return default end
  local n = tonumber(raw)
  if n == nil or n ~= math.floor(n) then
    warn(("%s: %s=%q is not an integer; using %d"):format(where, name, raw, default))
    return default
  end
  if n < 1 or n > ceiling then
    local clamped = math.max(1, math.min(ceiling, n))
    warn(("%s: %s=%d is outside 1..%d; using %d"):format(where, name, n, ceiling, clamped))
    return clamped
  end
  return n
end

local function build_question(div, kind)
  local attrs = div.attributes
  local where = div.identifier ~= "" and ("#" .. div.identifier) or ("." .. kind .. " after \"" .. last_heading .. "\"")

  -- Split the div into its (first) list and everything else.
  local list, other = nil, pandoc.List()
  for _, b in ipairs(div.content) do
    if list == nil and is_list(b) and kind == "poll" then
      list = b
    else
      other:insert(b)
    end
  end

  -- Options, correct answers, and the cleaned list.
  local options, correct = {}, {}
  local cleaned
  if list then
    local items = pandoc.List()
    for i, item in ipairs(list.content) do
      local checked, clean = strip_marker(item)
      if checked then table.insert(correct, i - 1) end
      items:insert(clean)
      local label = trim(pandoc.utils.stringify(pandoc.Div(clean)))
      if ulen(label) > LIMITS.optionChars then
        warn(("%s: option %d is longer than %d characters; truncated"):format(where, i, LIMITS.optionChars))
        label = utruncate(label, LIMITS.optionChars)
      end
      table.insert(options, label)
    end
    if list.t == "BulletList" then
      cleaned = pandoc.BulletList(items)
    else
      cleaned = pandoc.OrderedList(items, list.listAttributes)
    end
  end

  -- Prompt: attribute, else non-list text in the div, else preceding heading.
  local prompt = attrs.prompt
  if prompt == nil or trim(prompt) == "" then
    prompt = trim(pandoc.utils.stringify(other))
  end
  if prompt == "" then prompt = last_heading end
  prompt = trim((prompt or ""):gsub("%s+", " "))
  if prompt == "" then
    warn(("%s: no prompt (no prompt= attribute, text in the div, or preceding heading)"):format(where))
  end
  if ulen(prompt) > LIMITS.promptChars then
    warn(("%s: prompt is longer than %d characters; truncated"):format(where, LIMITS.promptChars))
    prompt = utruncate(prompt, LIMITS.promptChars)
  end

  -- Id: explicit, else generated from prompt and options.
  local id = div.identifier
  if id == "" then
    local basis = prompt .. "\n" .. table.concat(options, "\n")
    id = "q-" .. pandoc.utils.sha1(basis):sub(1, 10)
  elseif not valid_id(id) then
    warn(("question id %q must match [A-Za-z0-9][A-Za-z0-9_:.-]{0,63}; the server will reject it"):format(id))
  end
  if seen_ids[id] then
    warn(("duplicate question id %q (%s); give each question its own #id"):format(id, where))
  end
  seen_ids[id] = true

  local results = config.results
  if attrs.results ~= nil then
    results = results_mode(attrs.results, where)
  end

  local q
  if kind == "poll" then
    if #options < 2 then
      warn(("%s: a poll needs at least two options, found %d"):format(where, #options))
    end
    if #options > LIMITS.pollOptions then
      warn(("%s: a poll may have at most %d options, found %d"):format(where, LIMITS.pollOptions, #options))
    end
    q = { type = "poll", id = id, prompt = prompt, options = options, results = results }
    if #correct > 0 then q.correct = correct end
  else
    q = {
      type = "wordcloud",
      id = id,
      prompt = prompt,
      maxWords = int_attr(attrs, "max-words", DEFAULTS.maxWords, LIMITS.maxWordsCeiling, where),
      maxAnswers = int_attr(attrs, "max-answers", DEFAULTS.maxAnswers, LIMITS.maxAnswersCeiling, where),
      results = results,
    }
  end
  return q, other, cleaned
end

local function transform(div, kind)
  question_count = question_count + 1
  local q, other, cleaned = build_question(div, kind)

  if not is_reveal then
    -- Other formats: the prompt text (if any) and a plain list.
    local blocks = pandoc.List(other)
    if cleaned then blocks:insert(cleaned) end
    return blocks
  end

  local content = pandoc.List()
  if #other > 0 then
    content:insert(pandoc.Div(other, pandoc.Attr("", { "lp-text" })))
  end
  if cleaned then content:insert(cleaned) end

  local classes = { "lp-question", "lp-" .. kind }
  for _, c in ipairs(div.classes) do
    if c ~= kind then table.insert(classes, c) end
  end
  local json = pandoc.json.encode(q)
  return pandoc.Div(content, pandoc.Attr(q.id, classes, { ["data-lp"] = json }))
end

local function config_script()
  local out = {
    session = config.session,
    closeOnLeave = config.closeOnLeave,
    results = config.results,
    qr = config.qr,
  }
  if config.server then out.server = config.server end
  -- Keep "</script>" inside a JSON string from closing the element.
  local json = pandoc.json.encode(out):gsub("</", "<\\/")
  return '<script type="application/json" id="lp-config">' .. json .. "</script>"
end

return {
  {
    Meta = function(meta)
      read_config(meta)
    end,
  },
  {
    Pandoc = function(doc)
      doc.blocks = doc.blocks:walk({
        traverse = "topdown",
        Header = function(h)
          last_heading = trim(pandoc.utils.stringify(h.content))
        end,
        Div = function(div)
          local kind
          if div.classes:includes("poll") then kind = "poll"
          elseif div.classes:includes("wordcloud") then kind = "wordcloud"
          else return nil end
          -- Return false so the walk does not descend into the result.
          return transform(div, kind), false
        end,
      })
      if is_reveal then
        quarto.doc.include_text("in-header", config_script())
      end
      return doc
    end,
  },
}
