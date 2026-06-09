import * as path from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';
import { DependencyScanner } from '../scanner/DependencyScanner.js';

const execAsync = promisify(exec);

export interface ClassField {
    name: string;
    type: string;
    modifiers: string[];
}

export interface ClassMethod {
    name: string;
    returnType: string;
    parameters: string[];
    modifiers: string[];
}

export interface ClassAnalysis {
    className: string;
    packageName: string;
    modifiers: string[];
    superClass?: string;
    interfaces: string[];
    fields: ClassField[];
    methods: ClassMethod[];
}

export class JavaClassAnalyzer {
    private scanner: DependencyScanner;

    constructor() {
        this.scanner = new DependencyScanner();
    }

    /**
     * 分析Java类的结构信息
     */
    async analyzeClass(className: string, projectPath: string): Promise<ClassAnalysis> {
        try {
            // 1. 获取类文件路径
            const jarPath = await this.scanner.findJarForClass(className, projectPath);
            if (!jarPath) {
                throw new Error(`未找到类 ${className} 对应的JAR包`);
            }

            // 2. 直接使用 javap 分析JAR包中的类
            const analysis = await this.analyzeClassWithJavap(jarPath, className);

            return analysis;
        } catch (error) {
            console.error(`分析类 ${className} 失败:`, error);
            throw error;
        }
    }

    /**
     * 使用 javap 工具分析JAR包中的类结构
     */
    private async analyzeClassWithJavap(jarPath: string, className: string): Promise<ClassAnalysis> {
        try {
            const javapCmd = this.getJavapCommand();
            const quotedJavapCmd = javapCmd.includes(' ') ? `"${javapCmd}"` : javapCmd;
            const quotedJarPath = jarPath.includes(' ') ? `"${jarPath}"` : jarPath;

            // 使用 javap -v 获取详细信息（包括参数名称）
            const { stdout } = await execAsync(
                `${quotedJavapCmd} -v -cp ${quotedJarPath} ${className}`,
                { timeout: 10000 }
            );

            return this.parseJavapOutput(stdout, className);
        } catch (error) {
            console.error('javap 分析失败:', error);
            throw new Error(`javap 分析失败: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    /**
     * 解析 javap 输出
    */
    private parseJavapOutput(output: string, className: string): ClassAnalysis {
        const lines = output.split('\n');
        const analysis: ClassAnalysis = {
            className: className.split('.').pop() || className,
            packageName: '',
            modifiers: [],
            superClass: undefined,
            interfaces: [],
            fields: [],
            methods: []
        };

        let currentMethod: any = null;
        let inLocalVariableTable = false;
        let methodParameters: { [key: string]: string } = {};

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const trimmedLine = line.trim();

            // 解析类声明
            if (trimmedLine.startsWith('public class') || trimmedLine.startsWith('public interface') ||
                trimmedLine.startsWith('public enum')) {
                this.parseClassDeclaration(trimmedLine, analysis);
                continue;
            }

            // 解析方法声明
            if (trimmedLine.startsWith('public ') && trimmedLine.includes('(') && trimmedLine.includes(')')) {
                currentMethod = this.parseMethodFromJavap(trimmedLine);
                if (currentMethod) {
                    analysis.methods.push(currentMethod);
                    methodParameters = {};
                }
                continue;
            }

            // 检测 LocalVariableTable 开始
            if (trimmedLine === 'LocalVariableTable:') {
                inLocalVariableTable = true;
                continue;
            }

            // 解析 LocalVariableTable 中的参数名称
            if (inLocalVariableTable && currentMethod) {
                if (trimmedLine.startsWith('Start') || trimmedLine.startsWith('Slot')) {
                    continue; // 跳过表头
                }

                if (trimmedLine === '') {
                    // LocalVariableTable 结束，立即更新当前方法的参数名称
                    if (Object.keys(methodParameters).length > 0) {
                        const updatedParams: string[] = [];
                        for (let j = 0; j < currentMethod.parameters.length; j++) {
                            const paramType = currentMethod.parameters[j];
                            const paramName = methodParameters[j] || `param${j + 1}`;
                            updatedParams.push(`${paramType} ${paramName}`);
                        }
                        currentMethod.parameters = updatedParams;
                    }
                    inLocalVariableTable = false;
                    methodParameters = {};
                    continue;
                }

                // 解析参数行: "0       6     0  file   Ljava/io/File;"
                const paramMatch = trimmedLine.match(/^\s*\d+\s+\d+\s+(\d+)\s+(\w+)\s+(.+)$/);
                if (paramMatch) {
                    const slot = parseInt(paramMatch[1]);
                    const paramName = paramMatch[2];
                    const paramType = paramMatch[3];

                    // 只处理参数（slot >= 0，但排除局部变量）
                    // 参数通常在前几个 slot 中，局部变量在后面
                    if (slot >= 0 && slot < currentMethod.parameters.length) {
                        methodParameters[slot] = paramName;
                    }
                }
            }

            // 检测方法结束 - 当遇到下一个方法或类结束时
            if (currentMethod && (
                (trimmedLine.startsWith('public ') && trimmedLine.includes('(') && trimmedLine.includes(')')) ||
                trimmedLine.startsWith('}') ||
                trimmedLine.startsWith('SourceFile:')
            )) {
                // 更新方法的参数名称
                if (Object.keys(methodParameters).length > 0) {
                    const updatedParams: string[] = [];
                    for (let j = 0; j < currentMethod.parameters.length; j++) {
                        const paramType = currentMethod.parameters[j];
                        const paramName = methodParameters[j] || `param${j + 1}`;
                        updatedParams.push(`${paramType} ${paramName}`);
                    }
                    currentMethod.parameters = updatedParams;
                }
                currentMethod = null;
                inLocalVariableTable = false;
                methodParameters = {};
            }
        }

        return analysis;
    }

    /**
     * 解析类声明
     */
    private parseClassDeclaration(line: string, analysis: ClassAnalysis): void {
        // 提取修饰符
        const modifiers = line.match(/\b(public|private|protected|static|final|abstract|strictfp)\b/g) || [];
        analysis.modifiers = modifiers;

        // 提取包名（从类名推断）
        const classMatch = line.match(/(?:public\s+)?(?:class|interface|enum)\s+([a-zA-Z_$][a-zA-Z0-9_$.]*)/);
        if (classMatch) {
            const fullClassName = classMatch[1];
            const parts = fullClassName.split('.');
            if (parts.length > 1) {
                analysis.packageName = parts.slice(0, -1).join('.');
                analysis.className = parts[parts.length - 1];
            }
        }

        // 提取父类
        const extendsMatch = line.match(/extends\s+([a-zA-Z_$][a-zA-Z0-9_$.]*)/);
        if (extendsMatch) {
            analysis.superClass = extendsMatch[1];
        }

        // 提取接口
        const implementsMatch = line.match(/implements\s+([^{]+)/);
        if (implementsMatch) {
            const interfaces = implementsMatch[1]
                .split(',')
                .map(iface => iface.trim())
                .filter(iface => iface);
            analysis.interfaces = interfaces;
        }
    }

    /**
     * 从 javap 输出解析方法
     */
    private parseMethodFromJavap(line: string): ClassMethod | null {
        try {
            const trimmedLine = line.trim();

            // 提取修饰符
            const modifiers: string[] = [];
            let startIndex = 0;
            const modifierWords = ['public', 'private', 'protected', 'static', 'final', 'abstract', 'synchronized', 'native'];

            // 处理多个修饰符
            let remainingLine = trimmedLine;
            while (true) {
                let foundModifier = false;
                for (const modifier of modifierWords) {
                    if (remainingLine.startsWith(modifier + ' ')) {
                        modifiers.push(modifier);
                        remainingLine = remainingLine.substring(modifier.length + 1);
                        startIndex += modifier.length + 1;
                        foundModifier = true;
                        break;
                    }
                }
                if (!foundModifier) {
                    break;
                }
            }

            // 查找方法名和参数部分
            const parenIndex = trimmedLine.indexOf('(');
            if (parenIndex === -1) return null;

            const closeParenIndex = trimmedLine.indexOf(')', parenIndex);
            if (closeParenIndex === -1) return null;

            // 提取返回类型和方法名
            const beforeParen = trimmedLine.substring(startIndex, parenIndex).trim();
            const lastSpaceIndex = beforeParen.lastIndexOf(' ');
            if (lastSpaceIndex === -1) return null;

            const returnType = beforeParen.substring(0, lastSpaceIndex).trim();
            const methodName = beforeParen.substring(lastSpaceIndex + 1).trim();

            // 提取参数
            const paramsStr = trimmedLine.substring(parenIndex + 1, closeParenIndex).trim();
            const parameters: string[] = [];

            if (paramsStr) {
                // 处理参数，需要考虑泛型和嵌套类型
                const paramParts = this.splitParameters(paramsStr);
                for (const param of paramParts) {
                    const trimmedParam = param.trim();
                    if (trimmedParam) {
                        parameters.push(trimmedParam);
                    }
                }
            }

            return {
                name: methodName,
                returnType,
                parameters,
                modifiers
            };
        } catch (error) {
            console.error('解析方法失败:', line, error);
            return null;
        }
    }

    /**
     * 智能分割参数，处理泛型和嵌套类型
     */
    private splitParameters(paramsStr: string): string[] {
        const params: string[] = [];
        let current = '';
        let angleBracketCount = 0;

        for (let i = 0; i < paramsStr.length; i++) {
            const char = paramsStr[i];

            if (char === '<') {
                angleBracketCount++;
            } else if (char === '>') {
                angleBracketCount--;
            } else if (char === ',' && angleBracketCount === 0) {
                params.push(current.trim());
                current = '';
                continue;
            }

            current += char;
        }

        if (current.trim()) {
            params.push(current.trim());
        }

        return params;
    }


    /**
     * 获取javap命令路径
     */
    private getJavapCommand(): string {
        const javaHome = process.env.JAVA_HOME;
        if (javaHome) {
            const javapCmd = process.platform === 'win32' ? 'javap.exe' : 'javap';
            return path.join(javaHome, 'bin', javapCmd);
        }
        return 'javap';
    }

    /**
     * 获取类的继承层次结构
     */
    async getInheritanceHierarchy(className: string, projectPath: string): Promise<string[]> {
        const analysis = await this.analyzeClass(className, projectPath);
        const hierarchy: string[] = [className];

        if (analysis.superClass) {
            try {
                const superHierarchy = await this.getInheritanceHierarchy(analysis.superClass, projectPath);
                hierarchy.unshift(...superHierarchy);
            } catch (error) {
                // 如果父类不在当前项目中，直接添加
                hierarchy.unshift(analysis.superClass);
            }
        }

        return hierarchy;
    }

    /**
     * 查找类的所有子类
     */
    async findSubClasses(className: string, projectPath: string): Promise<string[]> {
        const allClasses = await this.scanner.getAllClassNames(projectPath);
        const subClasses: string[] = [];

        for (const cls of allClasses) {
            try {
                const analysis = await this.analyzeClass(cls, projectPath);
                if (analysis.superClass === className) {
                    subClasses.push(cls);
                }
            } catch (error) {
                // 忽略分析失败的类型
            }
        }

        return subClasses;
    }
}
