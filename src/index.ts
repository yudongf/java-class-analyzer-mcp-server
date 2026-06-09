#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { JavaClassAnalyzer } from './analyzer/JavaClassAnalyzer.js';
import { DependencyScanner } from './scanner/DependencyScanner.js';
import { DecompilerService } from './decompiler/DecompilerService.js';

export class JavaClassAnalyzerMCPServer {
    private server: Server;
    private analyzer: JavaClassAnalyzer;
    private scanner: DependencyScanner;
    private decompiler: DecompilerService;

    constructor() {
        this.server = new Server(
            {
                name: 'java-class-analyzer',
                version: '1.0.1',
                capabilities: {
                    tools: {
                        scan_dependencies: {
                            description: '扫描Maven项目的所有依赖，建立类名到JAR包的映射索引',
                        },
                        decompile_class: {
                            description: '反编译指定的Java类文件，返回Java源码',
                        },
                        analyze_class: {
                            description: '分析Java类的结构、方法、字段等信息',
                        },
                    },
                },
            }
        );

        this.analyzer = new JavaClassAnalyzer();
        this.scanner = new DependencyScanner();
        this.decompiler = new DecompilerService();

        this.setupHandlers();
    }

    private setupHandlers() {
        this.server.setRequestHandler(ListToolsRequestSchema, async () => {
            return {
                tools: [
                    {
                        name: 'scan_dependencies',
                        description: '扫描Maven项目的所有依赖，建立类名到JAR包的映射索引',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven项目根目录路径',
                                },
                                forceRefresh: {
                                    type: 'boolean',
                                    description: '是否强制刷新索引',
                                    default: false,
                                },
                            },
                            required: ['projectPath'],
                        },
                    },
                    {
                        name: 'decompile_class',
                        description: '反编译指定的Java类文件，返回Java源码',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                className: {
                                    type: 'string',
                                    description: '要反编译的Java类全名，如：com.example.QueryBizOrderDO',
                                },
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven项目根目录路径',
                                },
                                useCache: {
                                    type: 'boolean',
                                    description: '是否使用缓存，默认true',
                                    default: true,
                                },
                                cfrPath: {
                                    type: 'string',
                                    description: 'CFR反编译工具的jar包路径，可选',
                                },
                            },
                            required: ['className', 'projectPath'],
                        },
                    },
                    {
                        name: 'analyze_class',
                        description: '分析Java类的结构、方法、字段等信息',
                        inputSchema: {
                            type: 'object',
                            properties: {
                                className: {
                                    type: 'string',
                                    description: '要分析的Java类全名',
                                },
                                projectPath: {
                                    type: 'string',
                                    description: 'Maven项目根目录路径',
                                },
                            },
                            required: ['className', 'projectPath'],
                        },
                    },
                ],
            };
        });

        this.server.setRequestHandler(CallToolRequestSchema, async (request: any) => {
            const { name, arguments: args } = request.params;

            try {
                switch (name) {
                    case 'scan_dependencies':
                        return await this.handleScanDependencies(args);
                    case 'decompile_class':
                        return await this.handleDecompileClass(args);
                    case 'analyze_class':
                        return await this.handleAnalyzeClass(args);
                    default:
                        throw new Error(`Unknown tool: ${name}`);
                }
            } catch (error) {
                console.error(`工具调用异常 [${name}]:`, error);
                return {
                    content: [
                        {
                            type: 'text',
                            text: `工具调用失败: ${error instanceof Error ? error.message : String(error)}\n\n建议:\n1. 检查输入参数是否正确\n2. 确保已运行必要的准备工作\n3. 查看服务器日志获取详细信息`,
                        },
                    ],
                };
            }
        });
    }

    private async handleScanDependencies(args: any) {
        const { projectPath, forceRefresh = false } = args;

        const result = await this.scanner.scanProject(projectPath, forceRefresh);

        return {
            content: [
                {
                    type: 'text',
                    text: `依赖扫描完成！\n\n` +
                        `扫描的JAR包数量: ${result.jarCount}\n` +
                        `索引的类数量: ${result.classCount}\n` +
                        `索引文件路径: ${result.indexPath}\n\n` +
                        `示例索引条目:\n${result.sampleEntries.slice(0, 5).join('\n')}`,
                },
            ],
        };
    }

    private async handleDecompileClass(args: any) {
        const { className, projectPath, useCache = true, cfrPath } = args;

        try {
            console.error(`开始反编译类: ${className}, 项目路径: ${projectPath}, 使用缓存: ${useCache}, CFR路径: ${cfrPath || '自动查找'}`);

            // 检查索引是否存在，如果不存在则先创建
            await this.ensureIndexExists(projectPath);

            const sourceCode = await this.decompiler.decompileClass(className, projectPath, useCache, cfrPath);

            if (!sourceCode || sourceCode.trim() === '') {
                return {
                    content: [
                        {
                            type: 'text',
                            text: `警告: 类 ${className} 的反编译结果为空，可能是CFR工具问题或类文件损坏`,
                        },
                    ],
                };
            }

            return {
                content: [
                    {
                        type: 'text',
                        text: `类 ${className} 的反编译源码:\n\n\`\`\`java\n${sourceCode}\n\`\`\``,
                    },
                ],
            };
        } catch (error) {
            console.error(`反编译类 ${className} 失败:`, error);
            return {
                content: [
                    {
                        type: 'text',
                        text: `反编译失败: ${error instanceof Error ? error.message : String(error)}\n\n建议:\n1. 确保已运行 scan_dependencies 建立类索引\n2. 检查CFR工具是否正确安装\n3. 验证类名是否正确`,
                    },
                ],
            };
        }
    }

    private async handleAnalyzeClass(args: any) {
        const { className, projectPath } = args;

        // 检查索引是否存在，如果不存在则先创建
        await this.ensureIndexExists(projectPath);

        const analysis = await this.analyzer.analyzeClass(className, projectPath);

        let result = `类 ${className} 的分析结果:\n\n`;
        result += `包名: ${analysis.packageName}\n`;
        result += `类名: ${analysis.className}\n`;
        result += `修饰符: ${analysis.modifiers.join(' ')}\n`;
        result += `父类: ${analysis.superClass || '无'}\n`;
        result += `实现的接口: ${analysis.interfaces.join(', ') || '无'}\n\n`;

        if (analysis.fields.length > 0) {
            result += `字段 (${analysis.fields.length}个):\n`;
            analysis.fields.forEach(field => {
                result += `  - ${field.modifiers.join(' ')} ${field.type} ${field.name}\n`;
            });
            result += '\n';
        }

        if (analysis.methods.length > 0) {
            result += `方法 (${analysis.methods.length}个):\n`;
            analysis.methods.forEach(method => {
                result += `  - ${method.modifiers.join(' ')} ${method.returnType} ${method.name}(${method.parameters.join(', ')})\n`;
            });
            result += '\n';
        }

        return {
            content: [
                {
                    type: 'text',
                    text: result,
                },
            ],
        };
    }

    /**
     * 确保索引文件存在，如果不存在则自动创建
     */
    private async ensureIndexExists(projectPath: string): Promise<void> {
        const fs = await import('fs-extra');
        const path = await import('path');

        const indexPath = path.join(projectPath, '.mcp-class-index.json');

        if (!(await fs.pathExists(indexPath))) {
            console.error('索引文件不存在，正在自动创建...');
            try {
                await this.scanner.scanProject(projectPath, false);
                console.error('索引文件创建完成');
            } catch (error) {
                console.error('自动创建索引失败:', error);
                throw new Error(`无法创建类索引文件: ${error instanceof Error ? error.message : String(error)}`);
            }
        }
    }

    async run() {
        const transport = new StdioServerTransport();
        await this.server.connect(transport);

        const env = process.env.NODE_ENV || 'development';
        if (env === 'development') {
            console.error('Java Class Analyzer MCP Server running on stdio (DEBUG MODE)');
        } else {
            console.error('Java Class Analyzer MCP Server running on stdio');
        }
    }
}

const mcpServer = new JavaClassAnalyzerMCPServer();

// 添加全局异常处理，防止服务器崩溃
process.on('uncaughtException', (error) => {
    console.error('未捕获的异常:', error);
    // 不退出进程，继续运行
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('未处理的Promise拒绝:', reason);
    // 不退出进程，继续运行
});

mcpServer.run().catch((error) => {
    console.error('服务器启动失败:', error);
    process.exit(1);
});
