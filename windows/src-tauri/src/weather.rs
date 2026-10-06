// Weather for the island's weather tab and the little chip in its header.
//
// Open-Meteo: free, no account, no key. The only things sent are the city you typed
// in the settings (to find its coordinates) and those coordinates (to get the
// forecast). No location is guessed from the network.

use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

const GEOCODE: &str = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST: &str = "https://api.open-meteo.com/v1/forecast";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Place {
    pub name: String,
    /// Region and country, to tell two cities of the same name apart.
    pub detail: String,
    pub lat: f64,
    pub lon: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Day {
    pub date: String,
    pub code: i64,
    pub high: f64,
    pub low: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Weather {
    pub temp: f64,
    pub feels: f64,
    pub humidity: f64,
    pub wind: f64,
    /// WMO weather code.
    pub code: i64,
    pub is_day: bool,
    pub high: f64,
    pub low: f64,
    pub unit: String,
    pub wind_unit: String,
    pub days: Vec<Day>,
}

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .user_agent(concat!("Coucou/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|e| e.to_string())
}

async fn get_json(url: reqwest::Url) -> Result<Value, String> {
    let response = client()?
        .get(url)
        .send()
        .await
        .map_err(|e| format!("Can't reach the weather service: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("The weather service answered {}.", response.status()));
    }
    response.json().await.map_err(|e| format!("Unreadable weather answer: {e}"))
}

pub async fn search(query: &str) -> Result<Vec<Place>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let url = reqwest::Url::parse_with_params(
        GEOCODE,
        &[("name", query), ("count", "6"), ("language", "en"), ("format", "json")],
    )
    .map_err(|e| e.to_string())?;
    let json = get_json(url).await?;
    let found = json.get("results").and_then(Value::as_array).cloned().unwrap_or_default();
    Ok(found
        .iter()
        .filter_map(|r| {
            let text = |k: &str| r.get(k).and_then(Value::as_str).unwrap_or("");
            let detail = [text("admin1"), text("country")]
                .into_iter()
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join(", ");
            Some(Place {
                name: r.get("name")?.as_str()?.to_string(),
                detail,
                lat: r.get("latitude")?.as_f64()?,
                lon: r.get("longitude")?.as_f64()?,
            })
        })
        .collect())
}

pub async fn fetch(lat: f64, lon: f64, fahrenheit: bool) -> Result<Weather, String> {
    if !(-90.0..=90.0).contains(&lat) || !(-180.0..=180.0).contains(&lon) {
        return Err("That location isn't valid.".into());
    }
    let (lat_s, lon_s) = (lat.to_string(), lon.to_string());
    let url = reqwest::Url::parse_with_params(
        FORECAST,
        &[
            ("latitude", lat_s.as_str()),
            ("longitude", lon_s.as_str()),
            ("current", "temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"),
            ("daily", "weather_code,temperature_2m_max,temperature_2m_min"),
            ("timezone", "auto"),
            ("forecast_days", "5"),
            ("temperature_unit", if fahrenheit { "fahrenheit" } else { "celsius" }),
            ("wind_speed_unit", if fahrenheit { "mph" } else { "kmh" }),
        ],
    )
    .map_err(|e| e.to_string())?;
    let json = get_json(url).await?;

    let current = json.get("current").ok_or("The weather service sent nothing for now.")?;
    let num = |v: &Value, k: &str| v.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let daily = json.get("daily").cloned().unwrap_or(Value::Null);
    let list = |k: &str| daily.get(k).and_then(Value::as_array).cloned().unwrap_or_default();
    let (dates, codes, highs, lows) =
        (list("time"), list("weather_code"), list("temperature_2m_max"), list("temperature_2m_min"));

    let days: Vec<Day> = (0..dates.len())
        .map(|i| Day {
            date: dates[i].as_str().unwrap_or("").to_string(),
            code: codes.get(i).and_then(Value::as_i64).unwrap_or(0),
            high: highs.get(i).and_then(Value::as_f64).unwrap_or(0.0),
            low: lows.get(i).and_then(Value::as_f64).unwrap_or(0.0),
        })
        .collect();

    Ok(Weather {
        temp: num(current, "temperature_2m"),
        feels: num(current, "apparent_temperature"),
        humidity: num(current, "relative_humidity_2m"),
        wind: num(current, "wind_speed_10m"),
        code: current.get("weather_code").and_then(Value::as_i64).unwrap_or(0),
        is_day: current.get("is_day").and_then(Value::as_i64).unwrap_or(1) == 1,
        high: days.first().map(|d| d.high).unwrap_or(0.0),
        low: days.first().map(|d| d.low).unwrap_or(0.0),
        unit: if fahrenheit { "°F" } else { "°C" }.into(),
        wind_unit: if fahrenheit { "mph" } else { "km/h" }.into(),
        days,
    })
}
