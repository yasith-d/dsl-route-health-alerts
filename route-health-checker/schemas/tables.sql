CREATE TABLE unhealthy_routes_log (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    run_id VARCHAR(64) NOT NULL,
    route_id VARCHAR(64) NOT NULL,
    route_name VARCHAR(255),
    phone_number VARCHAR(64),
    country VARCHAR(64),
    app_version VARCHAR(64),
    battery INT,
    charging BOOLEAN,
    last_active_time BIGINT,
    issues JSONB NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT NOW()
);
