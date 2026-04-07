module.exports = {
    // 1. Mistral Function Calling Schema
    schema: {
        type: "function",
        function: {
            name: "getWeather",
            description: "Get the current real-time weather for a location. If the user asks for the weather but does NOT specify a city (e.g., 'What is the weather today?'), you MUST pass 'auto' as the location to automatically detect their current city.",
            parameters: {
                type: "object",
                properties: {
                    location: {
                        type: "string",
                        description: "The city name (e.g., 'London', 'Tokyo'). Pass 'auto' if the user didn't specify a city."
                    }
                },
                required: ["location"]
            }
        }
    },
    
    // 2. Execution Logic
    execute: async (args) => {
        console.log(`[Tool: getWeather] Fetching weather for: ${args.location}`);
        
        try {
            let lat, lon, city;

            // Step 1: Detect Location if the user said "auto" (Zero-Click Context)
            if (!args.location || args.location.toLowerCase() === 'auto') {
                const ipRes = await fetch('http://ip-api.com/json/');
                const ipData = await ipRes.json();
                
                if (ipData.status !== 'success') throw new Error("Could not detect IP location.");
                
                lat = ipData.lat;
                lon = ipData.lon;
                city = ipData.city;
                console.log(`[Tool: getWeather] Auto-detected user location: ${city} (${lat}, ${lon})`);
            } 
            // Step 2: Otherwise, find the coordinates for the specific city they asked for
            else {
                const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(args.location)}&count=1&language=en&format=json`);
                const geoData = await geoRes.json();
                
                if (!geoData.results || geoData.results.length === 0) {
                     return { success: false, message: `I couldn't find coordinates for the city: ${args.location}.` };
                }
                
                lat = geoData.results[0].latitude;
                lon = geoData.results[0].longitude;
                city = geoData.results[0].name;
            }

            // Step 3: Fetch the highly accurate weather data using the coordinates
            const weatherRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m&temperature_unit=celsius`);
            const weatherData = await weatherRes.json();

            // Helper to translate weather codes into readable text
            const wmoCodes = {
                0: 'Clear sky', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
                45: 'Fog', 48: 'Freezing fog', 51: 'Light drizzle', 53: 'Moderate drizzle',
                61: 'Slight rain', 63: 'Moderate rain', 65: 'Heavy rain', 71: 'Slight snow',
                73: 'Moderate snow', 75: 'Heavy snow', 95: 'Thunderstorm'
            };
            const condition = wmoCodes[weatherData.current.weather_code] || 'Unknown conditions';

            // Step 4: Return the structured data to Mistral so it can speak it!
            return {
                success: true,
                location: city,
                temperature: `${weatherData.current.temperature_2m}°C`,
                feels_like: `${weatherData.current.apparent_temperature}°C`,
                condition: condition,
                wind_speed: `${weatherData.current.wind_speed_10m} km/h`,
                humidity: `${weatherData.current.relative_humidity_2m}%`
            };

        } catch (error) {
            console.error(`[Tool: getWeather] Error:`, error);
            return { 
                success: false, 
                error: `Failed to fetch the weather: ${error.message}` 
            };
        }
    }
};