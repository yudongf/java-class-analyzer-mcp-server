#!/usr/bin/env node

import { Command } from 'commander';
import { JavaClassAnalyzerMCPServer } from './index.js';

const program = new Command();

program
    .name('java-class-analyzer-mcp')
    .description('Java Class Analyzer MCP Server - 用于Java类文件分析和反编译的MCP服务器')
    .version('1.0.1');

program
    .command('start')
    .description('启动MCP服务器')
    .option('-e, --env <environment>', '运行环境 (development|production)', 'production')
    .action(async (options) => {
        // 设置环境变量
        if (options.env) {
            process.env.NODE_ENV = options.env;
        }

        console.log(`启动Java Class Analyzer MCP Server (${options.env}模式)...`);

        const server = new JavaClassAnalyzerMCPServer();
        await server.run();
    });

program
    .command('test')
    .description('测试MCP服务器功能')
    .option('-p, --project <path>', 'Maven项目路径')
    .option('-c, --class <className>', '要测试的类名')
    .option('--no-cache', '不使用缓存')
    .option('--cfr-path <path>', 'CFR反编译工具路径')
    .action(async (options) => {
        console.log('测试模式 - 请使用 test-tools.js 进行完整测试');
        console.log('运行: node test-tools.js --help 查看详细用法');
    });

program
    .command('config')
    .description('生成MCP客户端配置示例')
    .option('-o, --output <file>', '输出配置文件路径', 'mcp-client-config.json')
    .action(async (options) => {
        const config = {
            mcpServers: {
                "java-class-analyzer": {
                    command: "java-class-analyzer-mcp",
                    args: ["start"],
                    env: {
                        NODE_ENV: "production",
                        MAVEN_REPO: process.env.MAVEN_REPO || "",
                        JAVA_HOME: process.env.JAVA_HOME || "",
                        CFR_PATH: process.env.CFR_PATH || ""
                    }
                }
            }
        };

        const fs = await import('fs-extra');
        await fs.default.writeJson(options.output, config, { spaces: 2 });
        console.log(`MCP客户端配置已生成: ${options.output}`);
        console.log('\n使用说明:');
        console.log('1. 将此配置添加到你的MCP客户端配置文件中');
        console.log('2. 根据需要修改环境变量设置');
        console.log('3. 重启MCP客户端');
    });

// 默认命令
if (process.argv.length === 2) {
    // 如果没有提供子命令，默认启动服务器
    process.env.NODE_ENV = process.env.NODE_ENV || 'production';
    const server = new JavaClassAnalyzerMCPServer();
    server.run().catch((error) => {
        console.error('服务器启动失败:', error);
        process.exit(1);
    });
} else {
    program.parse();
}
