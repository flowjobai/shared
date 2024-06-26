import { RDSDataClient, ExecuteStatementCommand, BatchExecuteStatementCommand } from "@aws-sdk/client-rds-data";
import { format } from "date-fns";
console.log("Initializing data api", process.env.DATA_API_ARN);
// Set the region if one is specified, else let it default to the SDK
const config = process.env.DATA_API_REGION ? { region: process.env.DATA_API_REGION } : {};
if (process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY) {
    config["credentials"] = {
        accessKeyId: process.env.ACCESS_KEY_ID,
        secretAccessKey: process.env.SECRET_ACCESS_KEY,
    };
}
const index = new RDSDataClient(config);
const database = {
    resourceArn: process.env.DATA_API_ARN,
    secretArn: process.env.DATA_API_SECRET_ARN,
    database: process.env.DATA_API_DATABASE,
};
class ExecuteResult {
    constructor(rows, updated) {
        this.rows = rows;
        this.updated = updated;
    }
    single() {
        return this.rows[0];
    }
    singleValues() {
        return this.values()[0];
    }
    formatted() {
        return this.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, field]) => [key, field.fmt])));
    }
    values() {
        return this.rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, field]) => [key, field.value])));
    }
}
//https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/client/rds-data/command/ExecuteStatementCommand/
export async function execute(sql, params) {
    const parameters = params ? Object.entries(params).map(([key, value]) => asParameter(key, value)) : [];
    const command = new ExecuteStatementCommand({
        sql,
        parameters,
        ...database,
        includeResultMetadata: true,
    });
    // try {
    const rows = [];
    const { columnMetadata, records, numberOfRecordsUpdated } = await index.send(command);
    if (columnMetadata && records) {
        //console.log(columnMetadata, records)
        for (const record of records) {
            // A record is an array of fields matching the columnMetadata array
            // [
            //     { longValue: 3 },
            //     { stringValue: 'apollo-contacts-export - 2024-03-27T095203.105.csv' },
            //     { isNull: true },
            //     { stringValue: '2024-04-09 17:48:17.510924' }
            const row = {};
            for (let i = 0; i < columnMetadata.length; i++) {
                const { name, typeName } = columnMetadata[i];
                const field = record[i];
                // Look for a null, then get the value irrespective of the key, which is longValue, stringValue...
                const value = field.isNull ? null : Object.values(field)[0];
                switch (typeName) {
                    case "timestamp":
                        const date = new Date(value);
                        row[name] = {
                            type: "date",
                            value: date,
                            fmt: value === null ? "" : format(date, "dd MMM HH:mm"),
                        };
                        break;
                    case "serial":
                    case "int4":
                        row[name] = {
                            type: "number",
                            value,
                            fmt: value === null ? "" : value.toLocaleString("en-US"),
                        };
                        break;
                    case "json":
                    case "jsonb":
                        row[name] = {
                            type: "object",
                            value: JSON.parse(value),
                            fmt: value || "",
                        };
                        break;
                    default:
                        row[name] = {
                            type: "string",
                            value,
                            fmt: value === null ? "" : value,
                        }; // The value is already the correct type
                }
            }
            rows.push(row);
        }
    }
    return new ExecuteResult(rows, numberOfRecordsUpdated || 0);
    // }
    // catch (err) {
    //     return err;
    // }
}
// Convert the deeper detailed fields to just the fmt value
export function formatted(rows) {
    return rows.map((row) => Object.fromEntries(Object.entries(row).map(([key, field]) => [key, field.fmt])));
}
export async function batch(sql, params) {
    homogeniseFields(sql, params);
    const parameterSets = params ? params.map((param) => Object.entries(param).map(([key, value]) => asParameter(key, value))) : [];
    const command = new BatchExecuteStatementCommand({
        sql,
        parameterSets,
        ...database,
    });
    const result = await index.send(command);
}
function asParameter(key, value) {
    if (value === null || value === undefined) {
        return { name: key, value: { isNull: true } };
    }
    switch (typeof value) {
        case "string":
            return { name: key, value: { stringValue: value } };
        case "number":
            return { name: key, value: { longValue: value } };
        case "boolean":
            return { name: key, value: { booleanValue: value } };
        case "object":
            if (value instanceof Date) {
                return { name: key, value: { stringValue: value.toISOString() } };
            }
            return { name: key, value: { stringValue: JSON.stringify(value) } };
        default:
            return { name: key, value: { stringValue: JSON.stringify(value) } };
    }
}
// Add entries with null for missing fields
export function homogeniseFields(sql, rows) {
    var _a;
    // Find all the fields in the SQL - fields start with a colon
    const fields = (_a = sql.match(/:([a-zA-Z0-9_]+)/g)) === null || _a === void 0 ? void 0 : _a.map((field) => field.slice(1));
    for (const row of rows) {
        for (const field of fields) {
            if (!row[field]) {
                row[field] = null;
            }
        }
    }
}
