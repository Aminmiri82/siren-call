-- Host-owned prelude. Only the explicit env below is visible to user code.
local set_mt = {}
local function set(ids)
  local result, seen = {}, {}
  for _, id in ipairs(ids) do
    if not seen[id] then result[#result + 1], seen[id] = id, true end
  end
  return setmetatable(result, set_mt)
end
local function combine(a, b, mode)
  local result, rhs = {}, {}
  for _, id in ipairs(b) do rhs[id] = true end
  for _, id in ipairs(a) do
    if mode == 'union' or (mode == 'intersection' and rhs[id]) or (mode == 'difference' and not rhs[id]) then
      result[#result + 1] = id
    end
  end
  if mode == 'union' then for _, id in ipairs(b) do result[#result + 1] = id end end
  return set(result)
end
set_mt.__add = function(a,b) return combine(a,b,'union') end
set_mt.__sub = function(a,b) return combine(a,b,'difference') end
set_mt.__mul = function(a,b) return combine(a,b,'intersection') end
local function select_members(predicate)
  local ids = {}
  for _, member in ipairs(context.members) do
    if predicate(member) then ids[#ids + 1] = member.id end
  end
  return set(ids)
end
local function everyone() return select_members(function() return true end) end
local function role(name)
  local matches = {}
  for _, r in ipairs(context.roles) do
    if r.id == name then matches = {r}; break end
    if r.name == name then matches[#matches + 1] = r end
  end
  assert(#matches == 1, #matches == 0 and 'Unknown role: '..tostring(name) or 'Ambiguous role name; use its ID: '..tostring(name))
  return select_members(function(member)
    for _, id in ipairs(member.roleIds) do if id == matches[1].id then return true end end
    return false
  end)
end
local resolve_member = resolve_member
local function member(reference)
  assert(type(reference) == 'string', 'Use member("name") or member("@username").')
  local id, problem = resolve_member(reference)
  if not id then error(problem, 2) end
  return set({id})
end
local function joined_after(date)
  assert(type(date) == 'string', 'Use a UTC date: YYYY-MM-DD')
  local y,m,d = date:match('^(%d%d%d%d)%-(%d%d)%-(%d%d)$')
  y,m,d = tonumber(y),tonumber(m),tonumber(d)
  assert(y and m >= 1 and m <= 12, 'Use a valid UTC date: YYYY-MM-DD')
  local leap = y % 4 == 0 and (y % 100 ~= 0 or y % 400 == 0)
  local days = {31,leap and 29 or 28,31,30,31,30,31,31,30,31,30,31}
  assert(d >= 1 and d <= days[m], 'Use a valid UTC date: YYYY-MM-DD')
  return select_members(function(member) return member.joinedAt and member.joinedAt > date..'T00:00:00.000Z' end)
end
local env = {
  assert=assert, error=error, ipairs=ipairs, pairs=pairs, next=next,
  tonumber=tonumber, tostring=tostring, type=type, pcall=pcall, xpcall=xpcall,
  math=math, string=string, table=table, utf8=utf8,
  everyone=everyone, role=role, member=member, joined_after=joined_after,
  select=select_members, members=context.members, caller_id=context.callerId,
  union=function(a,b) return combine(a,b,'union') end,
  intersection=function(a,b) return combine(a,b,'intersection') end,
  difference=function(a,b) return combine(a,b,'difference') end,
}
local fn, problem = load(source, 'siren', 't', env)
assert(fn, problem)
local result = fn()
assert(type(result) == 'table', 'Return { recipients = ..., message = "..." }')
assert(type(result.message) == 'string', 'message must be a string')
assert(#result.message <= 6000, 'Message is too long')
assert(type(result.recipients) == 'table', 'recipients must be a list of member IDs')
local count = 0
for key, id in pairs(result.recipients) do
  count = count + 1
  assert(count <= 5000, 'Too many recipients (maximum 5000)')
  assert(type(key) == 'number' and key >= 1 and key % 1 == 0, 'recipients must be a dense list')
  assert(type(id) == 'string' and id:match('^%d+$'), 'Recipient IDs must be strings of digits')
end
for i=1,count do assert(result.recipients[i] ~= nil, 'recipients must be a dense list') end
return { ids = table.concat(result.recipients, ','), message = result.message }
