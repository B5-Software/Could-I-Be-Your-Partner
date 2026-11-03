//! Private, versioned stdin/stdout protocol. No sockets or real-money broker.
use cibyp_quant_engine::{
    book::{Book, Coverage, Update},
    decimal::Fixed,
    execution_runner::ExecutionRunner,
    journal::{MAX_FRAME, line},
    ledger::execution::{Plan as ExecutionPlan, Report as ExecutionReport},
    ledger::{Instrument, Ledger, Risk, Submit},
    matching::{Matcher, Trade, now_ns},
    source_clock::{self, SourceClock},
    strategy::{Definition, Mode},
    strategy_runner::Runner,
};
use serde::{Deserialize, de::DeserializeOwned};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{self, BufReader, Write},
    path::PathBuf,
    process::ExitCode,
    sync::mpsc::{self, RecvTimeoutError},
    time::Duration,
};
const PROTOCOL: u32 = 1;
fn definition_hash(value: &Definition) -> Result<String, String> {
    use sha2::{Digest, Sha256};
    Ok(
        Sha256::digest(serde_json::to_vec(value).map_err(|_| "ENCODING_ERROR")?)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect(),
    )
}
fn strategy_page<T>(
    items: Vec<&T>,
    offset: usize,
    limit: usize,
    convert: impl Fn(&T) -> Result<Value, String>,
) -> Result<Value, String> {
    let total = items.len();
    let items = items
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(convert)
        .collect::<Result<Vec<_>, _>>()?;
    Ok(
        json!({"items":items,"total":total,"next":if offset.saturating_add(limit)<total{Some(offset+limit)}else{None}}),
    )
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Hello {
    protocol: u32,
    token: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Account {
    id: String,
    #[serde(default)]
    name: String,
    risk: Risk,
    assets: BTreeMap<String, Fixed>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Id {
    id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionStart {
    id: String,
    policy_id: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ExecutionClaim {
    id: String,
    lease: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrategyQuery {
    id: Option<String>,
    owner: Option<String>,
    run: Option<String>,
    revision: Option<u32>,
    #[serde(default)]
    offset: usize,
    #[serde(default = "page_size")]
    limit: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StartStrategy {
    run_id: String,
    id: String,
    revision: u32,
    mode: Mode,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StopStrategy {
    run_id: String,
    cancel: bool,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct StrategyView {
    owner: String,
    id: Option<String>,
    #[serde(default)]
    offset: usize,
    #[serde(default)]
    decision_offset: usize,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayEvent {
    method: String,
    params: Value,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ReplayStep {
    wall_ns: String,
    mono_ns: String,
    event: Option<ReplayEvent>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Snapshot {
    instrument: String,
    epoch: String,
    sequence: String,
    bids: Vec<[Fixed; 2]>,
    asks: Vec<[Fixed; 2]>,
    #[serde(default)]
    coverage: Coverage,
    source_time_ns: Option<String>,
    provider_time_ns: Option<String>,
    source_clock: Option<SourceClock>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Delta {
    instrument: String,
    epoch: String,
    sequence: String,
    updates: Vec<Update>,
    source_time_ns: Option<String>,
    provider_time_ns: Option<String>,
    source_clock: Option<SourceClock>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Orders {
    #[serde(default)]
    offset: usize,
    #[serde(default = "page_size")]
    limit: usize,
    account: Option<String>,
    strategy: Option<String>,
    open: Option<bool>,
}
fn page_size() -> usize {
    50
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Portfolio {
    account: Option<String>,
    strategy: String,
    kind: String,
    #[serde(default)]
    offset: usize,
    #[serde(default = "page_size")]
    limit: usize,
    #[serde(default)]
    account_offset: usize,
}
fn params<T: DeserializeOwned>(value: Value) -> Result<T, &'static str> {
    serde_json::from_value(value).map_err(|_| "INVALID_PARAMS")
}
fn sequence(value: &str) -> Result<u64, &'static str> {
    if value.is_empty() || value.len() > 20 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("INVALID_SEQUENCE");
    }
    value.parse().map_err(|_| "INVALID_SEQUENCE")
}
fn source_time(
    value: Option<&str>,
    provider: Option<&str>,
    clock: Option<&SourceClock>,
) -> Result<Option<u128>, &'static str> {
    let Some(value) = value else {
        return if provider.is_none() && clock.is_none() {
            Ok(None)
        } else {
            Err("SOURCE_CLOCK_INVALID")
        };
    };
    if value.is_empty() || value.len() > 39 || !value.bytes().all(|b| b.is_ascii_digit()) {
        return Err("INVALID_SOURCE_TIME");
    }
    let time = value.parse::<u128>().map_err(|_| "INVALID_SOURCE_TIME")?;
    let now = now_ns();
    source_clock::validate(time, provider, clock, now)?;
    if time > now.saturating_add(250_000_000) || now.saturating_sub(time) > 2_000_000_000 {
        return Err("SOURCE_TIME_STALE");
    }
    Ok(Some(time))
}
fn code(error: String) -> String {
    if error.len() <= 80
        && error
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        error
    } else if error.starts_with("DURABLE_COMMIT:") {
        "DURABLE_COMMIT_FAILED".into()
    } else {
        "ENGINE_OPERATION_FAILED".into()
    }
}
fn send(output: &mut impl Write, id: &str, result: Result<Value, String>) -> io::Result<()> {
    let envelope = match result {
        Ok(result) => json!({"id":id,"ok":true,"result":result}),
        Err(error) => json!({"id":id,"ok":false,"error":{"code":code(error)}}),
    };
    let mut bytes = serde_json::to_vec(&envelope)?;
    if bytes.len() + 1 > MAX_FRAME {
        return send(output, id, Err("RESPONSE_LIMIT".into()));
    }
    bytes.push(b'\n');
    output.write_all(&bytes)?;
    output.flush()
}
fn authenticated(given: &str, expected: &str) -> bool {
    if given.len() != 64 || expected.len() != 64 {
        return false;
    }
    given
        .bytes()
        .zip(expected.bytes())
        .fold(0u8, |value, (left, right)| value | (left ^ right))
        == 0
}
struct Engine {
    ledger: Ledger,
    books: BTreeMap<String, Book>,
    matcher: Matcher,
    strategies: Runner,
    execution: ExecutionRunner,
    replay_clock: Option<cibyp_quant_engine::clock::ReplayClock>,
}
impl Engine {
    fn request(&mut self, request: Request) -> Result<Value, String> {
        let instrument = request
            .method
            .starts_with("market.")
            .then(|| {
                request
                    .params
                    .get("instrument")
                    .or_else(|| request.params.get("id"))
                    .and_then(Value::as_str)
                    .map(str::to_owned)
            })
            .flatten();
        let result = self.process(request);
        if result.is_err()
            && let Some(instrument) = instrument
        {
            if let Some(book) = self.books.get_mut(&instrument) {
                book.suspend();
            }
            self.matcher.detach(&instrument);
        }
        result
    }
    fn process(&mut self, request: Request) -> Result<Value, String> {
        if self.replay_clock.is_some() && request.method.starts_with("execution.") {
            return Err("REPLAY_EXECUTION_DISABLED".into());
        }
        let value = request.params;
        match request.method.as_str() {
            "execution.create" => {
                let run = self
                    .ledger
                    .execution_create(params::<ExecutionPlan>(value)?)?;
                self.execution.generation = self.execution.generation.saturating_add(1);
                serde_json::to_value(run).map_err(|_| "ENCODING_ERROR".into())
            }
            "execution.get" => {
                let id = params::<Id>(value)?.id;
                serde_json::to_value(
                    self.ledger
                        .execution_run(&id)
                        .ok_or("EXECUTION_NOT_FOUND")?,
                )
                .map_err(|_| "ENCODING_ERROR".into())
            }
            "execution.start" => {
                let input = params::<ExecutionStart>(value)?;
                serde_json::to_value(self.execution.start(
                    &mut self.ledger,
                    &input.id,
                    &input.policy_id,
                )?)
                .map_err(|_| "ENCODING_ERROR".into())
            }
            "execution.stop" => {
                let id = params::<Id>(value)?.id;
                serde_json::to_value(self.execution.stop(&mut self.ledger, &id)?)
                    .map_err(|_| "ENCODING_ERROR".into())
            }
            "execution.hold" => {
                if value != json!({}) {
                    return Err("INVALID_EXECUTION_CONTROL".into());
                }
                self.execution
                    .hold_all(&mut self.ledger, "WALLET_EMERGENCY_STOPPED")?;
                Ok(json!({"held": true}))
            }
            "execution.claim" => {
                let input = params::<ExecutionClaim>(value)?;
                let command = self.ledger.execution_claim(&input.id, &input.lease)?;
                self.execution.generation = self.execution.generation.saturating_add(1);
                serde_json::to_value(command).map_err(|_| "ENCODING_ERROR".into())
            }
            "execution.report" => serde_json::to_value(
                self.execution
                    .report(&mut self.ledger, params::<ExecutionReport>(value)?)?,
            )
            .map_err(|_| "ENCODING_ERROR".into()),
            "execution.list" | "execution.pending" | "execution.commands" => {
                let page = params::<StrategyQuery>(value)?;
                if page.limit == 0 || page.limit > 100 {
                    return Err("INVALID_PAGINATION".into());
                }
                if request.method == "execution.commands" {
                    let id = page.id.as_ref().ok_or("EXECUTION_NOT_FOUND")?;
                    let run = self.ledger.execution_run(id).ok_or("EXECUTION_NOT_FOUND")?;
                    if page
                        .owner
                        .as_ref()
                        .is_some_and(|owner| owner != &run.plan.owner)
                    {
                        return Err("EXECUTION_SCOPE_MISMATCH".into());
                    }
                    return strategy_page(
                        self.ledger.execution_history(id),
                        page.offset,
                        page.limit,
                        |value| serde_json::to_value(value).map_err(|_| "ENCODING_ERROR".into()),
                    );
                }
                let runs = self
                    .ledger
                    .execution_runs()
                    .filter(|run| {
                        page.owner
                            .as_ref()
                            .is_none_or(|owner| owner == &run.plan.owner)
                            && page.id.as_ref().is_none_or(|id| id == &run.plan.id)
                            && (request.method != "execution.pending" || run.pending.is_some())
                    })
                    .collect::<Vec<_>>();
                strategy_page(runs, page.offset, page.limit, |run| {
                    if request.method == "execution.pending" {
                        let command = run
                            .pending
                            .as_ref()
                            .and_then(|id| self.ledger.execution_command(id))
                            .ok_or("EXECUTION_COMMAND_NOT_FOUND")?;
                        Ok(json!({"run":run,"command":command,"dispatch_allowed":
                            run.phase == cibyp_quant_engine::ledger::execution::Phase::Running &&
                            command.stage == cibyp_quant_engine::ledger::execution::Stage::Ready}))
                    } else {
                        serde_json::to_value(run).map_err(|_| "ENCODING_ERROR".into())
                    }
                })
            }
            "instrument.get" => {
                let id = params::<Id>(value)?.id;
                serde_json::to_value(
                    self.ledger
                        .instrument_value(&id)
                        .ok_or("INSTRUMENT_NOT_FOUND")?,
                )
                .map_err(|_| "ENCODING_ERROR".into())
            }
            "replay.step" => {
                let step = params::<ReplayStep>(value)?;
                if let Some(event) = &step.event
                    && ![
                        "market.snapshot",
                        "market.delta",
                        "market.trade",
                        "market.invalidate",
                    ]
                    .contains(&event.method.as_str())
                {
                    return Err("REPLAY_MARKET_EVENTS_ONLY".into());
                }
                let wall = step
                    .wall_ns
                    .parse::<u128>()
                    .map_err(|_| "INVALID_EVENT_TIME")?;
                let mono = step
                    .mono_ns
                    .parse::<u128>()
                    .map_err(|_| "INVALID_EVENT_TIME")?;
                let old = cibyp_quant_engine::clock::mono_ns();
                if self.replay_clock.is_none() {
                    return Err("REPLAY_CLOCK_REQUIRED".into());
                }
                if mono < old || mono > 86_400_000_000_000 || mono - old > 60_000_000_000 {
                    return Err("REPLAY_STEP_RANGE".into());
                }
                let old_wall = now_ns();
                let mut tick = (old / 50_000_000 + 1) * 50_000_000;
                while tick < mono {
                    self.replay_clock
                        .as_ref()
                        .ok_or("REPLAY_CLOCK_REQUIRED")?
                        .advance(old_wall.saturating_add(tick - old), tick)?;
                    self.strategies
                        .drive(&mut self.ledger, &self.books, &mut self.matcher);
                    tick += 50_000_000;
                }
                self.replay_clock
                    .as_ref()
                    .ok_or("REPLAY_CLOCK_REQUIRED")?
                    .advance(wall, mono)?;
                let applied = step.event.map(|event| {
                    match self.request(Request {
                        id: "replay".into(),
                        method: event.method,
                        params: event.params,
                    }) {
                        Ok(result) => json!({"ok":true,"result":result}),
                        Err(error) => json!({"ok":false,"error":code(error)}),
                    }
                });
                self.strategies
                    .drive(&mut self.ledger, &self.books, &mut self.matcher);
                Ok(json!({"wall_ns":wall.to_string(),"mono_ns":mono.to_string(),"event":applied}))
            }
            "strategy.view" => {
                let q = params::<StrategyView>(value)?;
                let list = self.process(Request {
                    id: "view".into(),
                    method: "strategy.list".into(),
                    params: json!({"owner":q.owner,"offset":q.offset,"limit":20}),
                })?;
                let selected = q.id.or_else(|| {
                    list["items"]
                        .as_array()
                        .and_then(|v| v.first())
                        .and_then(|v| v["definition"]["id"].as_str())
                        .map(str::to_string)
                });
                let mut definition = Value::Null;
                let mut runs = json!({"items":[],"total":0,"next":null});
                let mut decisions = json!({"items":[],"total":0,"next":null});
                if let Some(id) = selected {
                    definition = self.process(Request {
                        id: "view".into(),
                        method: "strategy.get".into(),
                        params: json!({"id":id}),
                    })?;
                    if definition["definition"]["owner"] != q.owner {
                        return Err("STRATEGY_SCOPE_MISMATCH".into());
                    }
                    runs = self.process(Request {
                        id: "view".into(),
                        method: "strategy.runs".into(),
                        params: json!({"owner":q.owner,"id":id,"limit":20}),
                    })?;
                    let items = runs["items"].as_array().ok_or("ENCODING_ERROR")?;
                    if let Some(run) = items
                        .iter()
                        .find(|r| r["phase"] == "running")
                        .or_else(|| items.first())
                    {
                        decisions=self.process(Request{id:"view".into(),method:"strategy.decisions".into(),params:json!({"run":run["run"]["id"],"offset":q.decision_offset,"limit":15})})?;
                    }
                }
                Ok(
                    json!({"definitionsPage":list,"selected":definition,"runsPage":runs,"decisionsPage":decisions}),
                )
            }
            "strategy.define" => {
                let definition = params::<Definition>(value)?;
                self.ledger.define_strategy(definition.clone())?;
                self.strategies.generation = self.strategies.generation.saturating_add(1);
                Ok(json!({"definition":definition,"hash":definition_hash(&definition)?}))
            }
            "strategy.get" => {
                let q = params::<StrategyQuery>(value)?;
                let definition = self
                    .ledger
                    .strategy(
                        q.id.as_deref().ok_or("STRATEGY_ID_REQUIRED")?,
                        q.revision.unwrap_or(0),
                    )
                    .ok_or("STRATEGY_NOT_FOUND")?;
                Ok(json!({"definition":definition,"hash":definition_hash(definition)?}))
            }
            "strategy.list" | "strategy.runs" | "strategy.decisions" => {
                let q = params::<StrategyQuery>(value)?;
                if q.limit == 0 || q.limit > 100 {
                    return Err("PAGE_RANGE".into());
                }
                match request.method.as_str() {
                    "strategy.list" => strategy_page(
                        self.ledger
                            .strategies()
                            .filter(|d| {
                                q.owner.as_ref().is_none_or(|owner| d.owner == *owner)
                                    && q.id.as_ref().is_none_or(|id| d.id == *id)
                                    && (q.id.is_some()
                                        || self
                                            .ledger
                                            .strategy(&d.id, 0)
                                            .is_some_and(|latest| latest.revision == d.revision))
                            })
                            .collect(),
                        q.offset,
                        q.limit,
                        |d| Ok(json!({"definition":d,"hash":definition_hash(d)?})),
                    ),
                    "strategy.runs" => strategy_page(
                        self.ledger
                            .strategy_runs()
                            .filter(|r| {
                                q.id.as_ref().is_none_or(|id| r.strategy == *id)
                                    && q.run.as_ref().is_none_or(|id| r.id == *id)
                                    && q.owner.as_ref().is_none_or(|owner| {
                                        self.ledger.strategy_owned_by(&r.strategy, owner)
                                    })
                            })
                            .collect(),
                        q.offset,
                        q.limit,
                        |r| self.strategies.run_view(&self.ledger, r),
                    ),
                    _ => {
                        let run = q.run.as_deref().ok_or("STRATEGY_RUN_REQUIRED")?;
                        strategy_page(
                            self.ledger.strategy_decisions(run).collect(),
                            q.offset,
                            q.limit,
                            |d| serde_json::to_value(d).map_err(|_| "ENCODING_ERROR".into()),
                        )
                    }
                }
            }
            "strategy.start" => {
                let input = params::<StartStrategy>(value)?;
                self.strategies.start(
                    &mut self.ledger,
                    &self.books,
                    input.run_id,
                    input.id,
                    input.revision,
                    input.mode,
                )
            }
            "strategy.stop" => {
                let input = params::<StopStrategy>(value)?;
                self.strategies.stop(
                    &mut self.ledger,
                    &mut self.matcher,
                    &input.run_id,
                    input.cancel,
                    "USER_STOPPED",
                )
            }
            "status" => Ok(
                json!({"protocol":PROTOCOL,"version":env!("CARGO_PKG_VERSION"),"mode":if self.replay_clock.is_some(){"replay"}else{"paper"},"liveExecution":false,"ledger":self.ledger.summary(),"books":self.books.len(),"matching":{"model":"conservative-l2-fifo","latencyMs":500},"feed":{"version":1,"boundedDepth":true,"sourceClock":true,"clockNormalization":true,"tradeSide":"maker"}}),
            ),
            "instrument.register" => {
                self.ledger.instrument(params::<Instrument>(value)?)?;
                Ok(json!({"ok":true}))
            }
            "account.create" => {
                let account = params::<Account>(value)?;
                self.ledger.account_named(
                    account.id,
                    account.name,
                    account.risk,
                    account.assets,
                )?;
                Ok(json!({"ok":true}))
            }
            "account.get" => self.ledger.account_view(&params::<Id>(value)?.id),
            "account.halt" | "account.reset-halt" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Safety {
                    id: String,
                    operation: String,
                }
                let input = params::<Safety>(value)?;
                let ids = self
                    .ledger
                    .open_account_orders(&input.id)
                    .map(|o| o.request.id.clone())
                    .collect::<Vec<_>>();
                let result = if request.method == "account.halt" {
                    self.ledger.halt_account(&input.id, &input.operation)?
                } else {
                    self.ledger.reset_halt(&input.id, &input.operation)?
                };
                for id in ids {
                    if self.ledger.order(&id).is_some_and(|o| !o.is_open()) {
                        self.matcher.cancelled(&id);
                    }
                }
                Ok(result)
            }
            "portfolio.view" => {
                let view = params::<Portfolio>(value)?;
                if !["orders", "executions"].contains(&view.kind.as_str()) {
                    return Err("INVALID_HISTORY_KIND".into());
                }
                let account = if let Some(id) = view.account {
                    self.ledger.account_view(&id)?
                } else {
                    Value::Null
                };
                let accounts = self.process(Request {
                    id: "view".into(),
                    method: "accounts".into(),
                    params: json!({"offset":view.account_offset,"limit":20}),
                })?;
                let history=self.process(Request{id:"view".into(),method:view.kind,params:json!({"strategy":view.strategy,"offset":view.offset,"limit":view.limit})})?;
                Ok(
                    json!({"account":account,"accountsPage":accounts,"historyPage":history,"ledger":self.ledger.summary()}),
                )
            }
            "accounts" => {
                let page = params::<Orders>(value)?;
                if page.limit == 0 || page.limit > 100 {
                    return Err("PAGE_RANGE".into());
                }
                let total = self.ledger.account_ids().count();
                let items = self
                    .ledger
                    .account_ids()
                    .skip(page.offset)
                    .take(page.limit)
                    .map(|id| {
                        let mut view = self.ledger.account_view(id)?;
                        view.as_object_mut()
                            .expect("account object")
                            .remove("assets");
                        view.as_object_mut().expect("account object").remove("risk");
                        Ok(view)
                    })
                    .collect::<Result<Vec<_>, String>>()?;
                Ok(
                    json!({"items":items,"total":total,"next":if page.offset.saturating_add(page.limit)<total{Some(page.offset+page.limit)}else{None}}),
                )
            }
            "account.enable" | "account.pause" => {
                let id = params::<Id>(value)?.id;
                self.ledger
                    .activate_account(&id, request.method == "account.enable")?;
                if request.method == "account.pause" {
                    for order in self
                        .ledger
                        .orders()
                        .filter(|o| o.request.account == id && o.is_open())
                    {
                        self.matcher.cancelled(&order.request.id);
                    }
                }
                self.ledger.account_view(&id)
            }
            "executions" => {
                let page = params::<Orders>(value)?;
                if page.limit == 0 || page.limit > 100 {
                    return Err("PAGE_RANGE".into());
                }
                let selected = || {
                    self.ledger.executions().filter(|e| {
                        page.account.as_ref().is_none_or(|id| e.account == *id)
                            && page
                                .strategy
                                .as_ref()
                                .is_none_or(|id| self.ledger.strategy_owned_by(&e.strategy, id))
                    })
                };
                let total = selected().count();
                let items = selected()
                    .skip(page.offset)
                    .take(page.limit)
                    .collect::<Vec<_>>();
                Ok(
                    json!({"items":items,"total":total,"next":if page.offset.saturating_add(page.limit)<total{Some(page.offset+page.limit)}else{None}}),
                )
            }
            "market.snapshot" => {
                let frame = params::<Snapshot>(value)?;
                let source_time = source_time(
                    frame.source_time_ns.as_deref(),
                    frame.provider_time_ns.as_deref(),
                    frame.source_clock.as_ref(),
                )?;
                let instrument = frame.instrument.clone();
                let seq = sequence(&frame.sequence)?;
                if self.ledger.instrument_value(&frame.instrument).is_none() {
                    return Err("INSTRUMENT_NOT_FOUND".into());
                }
                if self.books.len() >= 1000 && !self.books.contains_key(&frame.instrument) {
                    return Err("INSTRUMENT_LIMIT".into());
                }
                let book = self.books.entry(frame.instrument).or_default();
                let duplicate = book.valid() && book.epoch == frame.epoch && book.sequence == seq;
                if let Err(error) =
                    book.snapshot_bounded(frame.epoch, seq, frame.bids, frame.asks, frame.coverage)
                {
                    self.matcher.detach(&instrument);
                    return Err(error.into());
                }
                if !duplicate {
                    book.source_time(source_time);
                    book.provider_time = frame.provider_time_ns;
                    book.source_clock = frame.source_clock;
                    self.matcher.detach(&instrument);
                }
                Ok(book.status(1000, 10))
            }
            "market.delta" => {
                let frame = params::<Delta>(value)?;
                let source_time = source_time(
                    frame.source_time_ns.as_deref(),
                    frame.provider_time_ns.as_deref(),
                    frame.source_clock.as_ref(),
                )?;
                let book = self
                    .books
                    .get_mut(&frame.instrument)
                    .ok_or("BOOK_SNAPSHOT_REQUIRED")?;
                let applied =
                    match book.delta(&frame.epoch, sequence(&frame.sequence)?, frame.updates) {
                        Ok(value) => value,
                        Err(error) => {
                            self.matcher.detach(&frame.instrument);
                            return Err(error.into());
                        }
                    };
                if applied && let Err(error) = self.matcher.observe(&frame.instrument, book) {
                    book.suspend();
                    self.matcher.detach(&frame.instrument);
                    return Err(error);
                }
                if applied {
                    book.source_time(source_time);
                    book.provider_time = frame.provider_time_ns;
                    book.source_clock = frame.source_clock;
                }
                Ok(json!({"applied":applied,"book":book.status(1000,10)}))
            }
            "market.invalidate" => {
                let id = params::<Id>(value)?.id;
                if let Some(book) = self.books.get_mut(&id) {
                    book.suspend();
                }
                self.matcher.detach(&id);
                Ok(json!({"invalidated":true}))
            }
            "market.trade" => {
                let trade = params::<Trade>(value)?;
                let instrument = trade.instrument.clone();
                let book = self
                    .books
                    .get_mut(&instrument)
                    .ok_or("BOOK_SNAPSHOT_REQUIRED")?;
                match self.matcher.trade(&mut self.ledger, book, trade, now_ns()) {
                    Ok(matched) => {
                        serde_json::to_value(matched).map_err(|_| "ENCODING_ERROR".into())
                    }
                    Err(error) => {
                        book.suspend();
                        self.matcher.detach(&instrument);
                        Err(error)
                    }
                }
            }
            "book" => {
                let frame = params::<Id>(value)?;
                Ok(self
                    .books
                    .get(&frame.id)
                    .ok_or("BOOK_SNAPSHOT_REQUIRED")?
                    .status(1000, 50))
            }
            "enable" => {
                self.ledger.enable()?;
                Ok(self.ledger.summary())
            }
            "pause" => {
                self.execution.hold_all(&mut self.ledger, "GLOBAL_PAUSED")?;
                self.ledger.pause();
                self.strategies
                    .hold_all(&mut self.ledger, &mut self.matcher, "GLOBAL_PAUSED");
                self.matcher.detach_all();
                Ok(self.ledger.summary())
            }
            "order.submit" => {
                let submit = params::<Submit>(value)?;
                let empty = Book::default();
                if !self.books.contains_key(&submit.instrument)
                    && self.ledger.order(&submit.id).is_none()
                {
                    return Err("BOOK_SNAPSHOT_REQUIRED".into());
                }
                let book = self.books.get(&submit.instrument).unwrap_or(&empty);
                let ticket = if self.ledger.order(&submit.id).is_none() {
                    Some(self.matcher.prepare(&submit, book, now_ns(), 500)?)
                } else {
                    None
                };
                let result = self
                    .ledger
                    .submit(submit.clone(), &submit.instrument, book, 1000)?;
                if let Some(ticket) = ticket {
                    self.matcher.attach(ticket);
                }
                let mut response = serde_json::to_value(&result).map_err(|_| "ENCODING_ERROR")?;
                response["execution"] = self.matcher.runtime(&result.order);
                Ok(response)
            }
            "order.cancel" => {
                let order = self.ledger.cancel(&params::<Id>(value)?.id)?;
                self.matcher.cancelled(&order.request.id);
                serde_json::to_value(order).map_err(|_| "ENCODING_ERROR".into())
            }
            "order.get" => {
                let id = params::<Id>(value)?.id;
                let order = self.ledger.order(&id).ok_or("ORDER_NOT_FOUND")?;
                let mut result = serde_json::to_value(order).map_err(|_| "ENCODING_ERROR")?;
                result["execution"] = self.matcher.runtime(order);
                result["owner"] = json!(self.ledger.order_owner(order));
                Ok(result)
            }
            "orders" => {
                let page = params::<Orders>(value)?;
                if page.limit == 0 || page.limit > 100 {
                    return Err("PAGE_RANGE".into());
                }
                let selected = || {
                    self.ledger.orders().filter(|o| {
                        page.account
                            .as_ref()
                            .is_none_or(|id| o.request.account == *id)
                            && page.open.is_none_or(|open| o.is_open() == open)
                            && page.strategy.as_ref().is_none_or(|id| {
                                self.ledger.strategy_owned_by(&o.request.strategy, id)
                            })
                    })
                };
                let total = selected().count();
                let items = selected()
                    .skip(page.offset)
                    .take(page.limit)
                    .map(|order| {
                        let mut value = serde_json::to_value(order).expect("serializable order");
                        value["execution"] = self.matcher.runtime(order);
                        value["owner"] = json!(self.ledger.order_owner(order));
                        value
                    })
                    .collect::<Vec<_>>();
                Ok(
                    json!({"items":items,"total":total,"next":if page.offset.saturating_add(page.limit)<total{Some(page.offset+page.limit)}else{None}}),
                )
            }
            _ => Err("METHOD_NOT_FOUND".into()),
        }
    }
}
fn main() -> ExitCode {
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!(
            "cibyp-quant-engine {} protocol={PROTOCOL}",
            env!("CARGO_PKG_VERSION")
        );
        return ExitCode::SUCCESS;
    }
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(_) => {
            eprintln!("Native engine stopped; inspect its private journal before recovery.");
            ExitCode::FAILURE
        }
    }
}
fn run() -> io::Result<()> {
    let mut arguments = std::env::args_os().skip(1);
    let first = arguments.next();
    let replay = first.as_deref() == Some(std::ffi::OsStr::new("--replay"));
    let directory_flag = if replay { arguments.next() } else { first };
    if directory_flag.as_deref() != Some(std::ffi::OsStr::new("--data-dir")) {
        return Err(io::Error::other("DATA_DIRECTORY_REQUIRED"));
    }
    let directory = PathBuf::from(
        arguments
            .next()
            .ok_or_else(|| io::Error::other("DATA_DIRECTORY_REQUIRED"))?,
    );
    if !directory.is_absolute() || arguments.next().is_some() {
        return Err(io::Error::other("INVALID_ARGUMENTS"));
    }
    let token = std::env::var("CIBYP_ENGINE_TOKEN").unwrap_or_default();
    if token.len() != 64 || !token.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(io::Error::other("AUTHENTICATION_REQUIRED"));
    }
    let (sender, receiver) = mpsc::sync_channel(8);
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut input = BufReader::new(stdin.lock());
        loop {
            let result = line(&mut input);
            let done = !matches!(result, Ok(Some(_)));
            if sender.send(result).is_err() || done {
                break;
            }
        }
    });
    let stdout = io::stdout();
    let mut output = stdout.lock();
    let first = receiver
        .recv()
        .map_err(|_| io::Error::other("HANDSHAKE_REQUIRED"))??
        .ok_or_else(|| io::Error::other("HANDSHAKE_REQUIRED"))?;
    let request: Request = serde_json::from_slice(&first)?;
    if request.id.is_empty()
        || request.id.len() > 100
        || !request
            .id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
    {
        return Err(io::Error::other("INVALID_REQUEST_ID"));
    }
    let hello = params::<Hello>(request.params).map_err(io::Error::other)?;
    if request.method != "hello"
        || hello.protocol != PROTOCOL
        || !authenticated(&hello.token, &token)
    {
        send(
            &mut output,
            &request.id,
            Err("AUTHENTICATION_OR_VERSION_FAILED".into()),
        )?;
        return Err(io::Error::other("AUTHENTICATION_FAILED"));
    }
    let replay_clock = if replay {
        Some(cibyp_quant_engine::clock::ReplayClock::enter().map_err(io::Error::other)?)
    } else {
        None
    };
    let mut ledger = Ledger::open(&directory, 256 * 1024 * 1024)
        .map_err(|_| io::Error::other("LEDGER_OPEN_FAILED"))?;
    ledger.recover_executions().map_err(io::Error::other)?;
    let mut engine = Engine {
        ledger,
        books: BTreeMap::new(),
        matcher: Matcher::default(),
        strategies: Runner::default(),
        execution: ExecutionRunner::default(),
        replay_clock,
    };
    send(
        &mut output,
        &request.id,
        Ok(
            json!({"protocol":PROTOCOL,"version":env!("CARGO_PKG_VERSION"),"mode":if replay{"replay"}else{"paper"},"liveExecution":false,"executionOutbox":2,"executionHalt":1,"pid":std::process::id()}),
        ),
    )?;
    let mut generation = 0;
    let mut execution_generation = 0;
    let mut faulted = false;
    loop {
        if !replay {
            engine
                .execution
                .drive(&mut engine.ledger)
                .map_err(io::Error::other)?;
            engine
                .strategies
                .drive(&mut engine.ledger, &engine.books, &mut engine.matcher);
        }
        if execution_generation != engine.execution.generation {
            execution_generation = engine.execution.generation;
            serde_json::to_writer(
                &mut output,
                &json!({"event":"execution","protocol":PROTOCOL,
                "generation":execution_generation.to_string(),"faulted":engine.ledger.faulted()}),
            )?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
        if generation != engine.strategies.generation || faulted != engine.ledger.faulted() {
            generation = engine.strategies.generation;
            faulted = engine.ledger.faulted();
            serde_json::to_writer(
                &mut output,
                &json!({"event":"strategy","protocol":PROTOCOL,"generation":generation.to_string(),"faulted":faulted}),
            )?;
            output.write_all(b"\n")?;
            output.flush()?;
        }
        let bytes = match receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(Some(bytes))) => bytes,
            Ok(Ok(None)) | Err(RecvTimeoutError::Disconnected) => break,
            Ok(Err(error)) => return Err(error),
            Err(RecvTimeoutError::Timeout) => continue,
        };
        let request: Request = match serde_json::from_slice(&bytes) {
            Ok(request) => request,
            Err(_) => {
                send(&mut output, "", Err("INVALID_REQUEST".into()))?;
                continue;
            }
        };
        if request.id.is_empty()
            || request.id.len() > 100
            || !request
                .id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b"_:-".contains(&b))
        {
            send(&mut output, "", Err("INVALID_REQUEST_ID".into()))?;
            continue;
        }
        if request.method == "shutdown" {
            engine
                .execution
                .hold_all(&mut engine.ledger, "ENGINE_SHUTDOWN")
                .map_err(io::Error::other)?;
            engine
                .strategies
                .hold_all(&mut engine.ledger, &mut engine.matcher, "ENGINE_SHUTDOWN");
            engine.ledger.pause();
            send(&mut output, &request.id, Ok(json!({"stopped":true})))?;
            return Ok(());
        }
        let id = request.id.clone();
        send(&mut output, &id, engine.request(request))?;
    }
    // Parent pipe closed: do not remain as an orphan execution process.
    engine
        .execution
        .hold_all(&mut engine.ledger, "PARENT_CLOSED")
        .map_err(io::Error::other)?;
    engine
        .strategies
        .hold_all(&mut engine.ledger, &mut engine.matcher, "PARENT_CLOSED");
    engine.ledger.pause();
    Ok(())
}
